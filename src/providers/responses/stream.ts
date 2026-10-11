import type {
  AssistantEventStream,
  AssistantMessageBuilder,
  HostedToolAction,
  HostedToolContent,
  ModelUsage,
  TextContent,
  ThinkingContent,
  ToolCallContent,
} from "@/core";
import { isRecord } from "@/utils";

export type ResponsesStreamState = {
  terminalSeen: boolean;
  stopReason?: "stop" | "length" | "toolUse";
  usage?: ModelUsage;
};

export class ResponsesStreamError extends Error {
  readonly name = "ResponsesStreamError";

  constructor(
    readonly eventType: "error" | "response.failed",
    readonly retryable: boolean,
    message: string,
    readonly providerCode?: string,
    readonly providerParam?: string,
    public requestId?: string,
  ) {
    super(message);
  }
}

export function isRetryableResponsesStreamError(error: unknown): error is ResponsesStreamError {
  return error instanceof ResponsesStreamError && error.retryable;
}

export type ResponsesStreamProcessorOptions = {
  provider: string;
  providerLabel: string;
  // Provider adapters may remove transport-only metadata from the semantic
  // action while the processor still preserves the raw item for replay.
  normalizeHostedToolAction?: (
    action: HostedToolAction,
    item: Readonly<Record<string, unknown>>,
  ) => HostedToolAction;
};

type PendingItem = {
  kind: "reasoning" | "message" | "function_call" | "web_search_call";
  contentIndex: number;
  item: Record<string, unknown>;
};

const START_EVENT = {
  reasoning: "thinking_start",
  message: "text_start",
  function_call: "toolcall_start",
  web_search_call: "hosted_tool_start",
} as const;

// Responses providers share semantic item events, while each adapter keeps
// ownership of request construction, transport, authentication, and replay.
export class ResponsesStreamProcessor {
  private readonly pendingByIndex = new Map<number, PendingItem>();
  private readonly pendingById = new Map<string, PendingItem>();
  private readonly completedItemIds = new Set<string>();
  private outputStarted = false;
  private nextSyntheticIndex = 0;

  constructor(
    private readonly stream: AssistantEventStream,
    private readonly message: AssistantMessageBuilder,
    private readonly state: ResponsesStreamState,
    private readonly options: ResponsesStreamProcessorOptions,
  ) {}

  get hasStartedOutput(): boolean {
    return this.outputStarted;
  }

  apply(event: Record<string, unknown>): void {
    const type = readString(event.type);
    switch (type) {
      case "response.output_item.added":
        this.addItem(event);
        return;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        this.applyThinkingDelta(event);
        return;
      case "response.reasoning_summary_part.done":
        this.finishThinkingPart(event);
        return;
      case "response.output_text.delta":
      case "response.refusal.delta":
        this.applyTextDelta(event);
        return;
      case "response.function_call_arguments.delta":
        this.applyToolCallDelta(event);
        return;
      case "response.function_call_arguments.done":
        this.applyToolCallArgumentsDone(event);
        return;
      case "response.output_item.done":
        this.completeItem(event);
        return;
      case "response.completed":
      case "response.done":
      case "response.incomplete":
        this.completeResponse(event, type);
        return;
      case "response.failed":
        throw createResponsesStreamError(
          event,
          "response.failed",
          readResponseError(event) ?? `${this.options.providerLabel} response failed.`,
        );
      case "error":
        throw createResponsesStreamError(
          event,
          "error",
          readEventError(event) ?? `${this.options.providerLabel} stream returned an error.`,
        );
      default:
        return;
    }
  }

  private addItem(event: Record<string, unknown>): void {
    const item = requireRecord(event.item, `${this.options.providerLabel} output item`);
    const outputIndex = readOutputIndex(event, this.nextSyntheticIndex++);
    const itemId = readString(item.id);
    if (itemId !== undefined && this.completedItemIds.has(itemId)) {
      return;
    }
    if (this.pendingByIndex.has(outputIndex)) {
      return;
    }

    const type = readString(item.type);
    if (
      type !== "reasoning" &&
      type !== "message" &&
      type !== "function_call" &&
      type !== "web_search_call"
    ) {
      return;
    }
    this.outputStarted = true;
    const contentIndex = this.message.add(this.createContent(type, item));
    const pending: PendingItem = { kind: type, contentIndex, item };
    this.stream.push({
      type: START_EVENT[type],
      contentIndex,
      snapshot: this.message.snapshot(),
    });

    this.pendingByIndex.set(outputIndex, pending);
    if (itemId !== undefined) {
      this.pendingById.set(itemId, pending);
    }
  }

  private createContent(
    type: PendingItem["kind"],
    item: Record<string, unknown>,
  ): ThinkingContent | TextContent | ToolCallContent | HostedToolContent {
    const label = this.options.providerLabel;
    switch (type) {
      case "reasoning":
        return { type: "thinking", text: "" };
      case "message":
        return { type: "text", text: "" };
      case "function_call": {
        const rawArgs = readString(item.arguments) ?? "";
        return {
          type: "tool_call",
          id: requireString(item.call_id, `${label} function call ID`),
          name: requireString(item.name, `${label} function name`),
          args: parseToolArguments(rawArgs),
          rawArgs,
        };
      }
      case "web_search_call":
        return {
          type: "hosted_tool",
          id: requireString(item.id, `${label} web search call ID`),
          name: "web_search",
          status: "in_progress",
        };
    }
  }

  private applyThinkingDelta(event: Record<string, unknown>): void {
    const pending = this.findPending(event);
    const delta = readString(event.delta);
    if (pending?.kind !== "reasoning" || !delta) {
      return;
    }
    this.message.appendText(pending.contentIndex, delta);
    this.stream.push({
      type: "thinking_delta",
      contentIndex: pending.contentIndex,
      delta,
      snapshot: this.message.snapshot(),
    });
  }

  private finishThinkingPart(event: Record<string, unknown>): void {
    const pending = this.findPending(event);
    if (pending?.kind !== "reasoning" || !this.textAt(pending)) {
      return;
    }
    const delta = "\n\n";
    this.message.appendText(pending.contentIndex, delta);
    this.stream.push({
      type: "thinking_delta",
      contentIndex: pending.contentIndex,
      delta,
      snapshot: this.message.snapshot(),
    });
  }

  private applyTextDelta(event: Record<string, unknown>): void {
    const pending = this.findPending(event);
    const delta = readString(event.delta);
    if (pending?.kind !== "message" || !delta) {
      return;
    }
    this.message.appendText(pending.contentIndex, delta);
    this.stream.push({
      type: "text_delta",
      contentIndex: pending.contentIndex,
      delta,
      snapshot: this.message.snapshot(),
    });
  }

  private applyToolCallDelta(event: Record<string, unknown>): void {
    const pending = this.findPending(event);
    const delta = readString(event.delta);
    if (pending?.kind !== "function_call" || !delta) {
      return;
    }
    // Arguments are parsed once the item completes; partial JSON never parses.
    this.message.update<ToolCallContent>(pending.contentIndex, (call) => ({
      ...call,
      rawArgs: (call.rawArgs ?? "") + delta,
    }));
    this.stream.push({
      type: "toolcall_delta",
      contentIndex: pending.contentIndex,
      delta,
      snapshot: this.message.snapshot(),
    });
  }

  private applyToolCallArgumentsDone(event: Record<string, unknown>): void {
    const pending = this.findPending(event);
    const rawArgs = readString(event.arguments);
    if (pending?.kind !== "function_call" || rawArgs === undefined) {
      return;
    }
    let previous = "";
    this.message.update<ToolCallContent>(pending.contentIndex, (call) => {
      previous = call.rawArgs ?? "";
      return { ...call, rawArgs, args: parseToolArguments(rawArgs) };
    });
    if (rawArgs.startsWith(previous) && rawArgs.length > previous.length) {
      const delta = rawArgs.slice(previous.length);
      this.stream.push({
        type: "toolcall_delta",
        contentIndex: pending.contentIndex,
        delta,
        snapshot: this.message.snapshot(),
      });
    }
  }

  private completeItem(event: Record<string, unknown>): void {
    const item = requireRecord(event.item, `${this.options.providerLabel} completed output item`);
    let pending = this.findPending({ ...event, item_id: item.id });
    if (pending === undefined) {
      this.addItem({ ...event, item });
      pending = this.findPending({ ...event, item_id: item.id });
    }
    if (pending === undefined) {
      return;
    }
    this.finishPending(pending, item);
  }

  private finishPending(pending: PendingItem, item: Record<string, unknown>): void {
    const itemId = readString(item.id);
    const providerState = { provider: this.options.provider, value: item };
    const { contentIndex } = pending;

    if (pending.kind === "reasoning") {
      const content = this.message.update<ThinkingContent>(contentIndex, (block) => ({
        ...block,
        text: readReasoningText(item) || block.text.replace(/\n\n$/, ""),
        providerState,
      }));
      this.stream.push({
        type: "thinking_end",
        contentIndex,
        content: content.text,
        snapshot: this.message.snapshot(),
      });
    } else if (pending.kind === "message") {
      const content = this.message.update<TextContent>(contentIndex, (block) => ({
        ...block,
        text: readMessageText(item) ?? block.text,
        providerState,
      }));
      this.stream.push({
        type: "text_end",
        contentIndex,
        content: content.text,
        snapshot: this.message.snapshot(),
      });
    } else if (pending.kind === "function_call") {
      const toolCall = this.message.update<ToolCallContent>(contentIndex, (call) => {
        const rawArgs = readString(item.arguments) ?? call.rawArgs ?? "";
        return {
          ...call,
          id: readString(item.call_id) ?? call.id,
          name: readString(item.name) ?? call.name,
          rawArgs,
          args: parseToolArguments(rawArgs),
          providerState,
        };
      });
      this.stream.push({
        type: "toolcall_end",
        contentIndex,
        toolCall,
        snapshot: this.message.snapshot(),
      });
    } else {
      const action = readHostedToolAction(item.action);
      const hostedTool = this.message.update<HostedToolContent>(contentIndex, (tool) => ({
        ...tool,
        status: "completed",
        action:
          action === undefined
            ? undefined
            : (this.options.normalizeHostedToolAction?.(action, item) ?? action),
        providerState,
      }));
      this.stream.push({
        type: "hosted_tool_end",
        contentIndex,
        hostedTool,
        snapshot: this.message.snapshot(),
      });
    }

    for (const [index, candidate] of this.pendingByIndex) {
      if (candidate === pending) {
        this.pendingByIndex.delete(index);
      }
    }
    for (const [id, candidate] of this.pendingById) {
      if (candidate === pending) {
        this.pendingById.delete(id);
      }
    }
    if (itemId !== undefined) {
      this.completedItemIds.add(itemId);
    }
  }

  private completeResponse(event: Record<string, unknown>, eventType: string): void {
    const response = isRecord(event.response) ? event.response : {};
    const output = Array.isArray(response.output) ? response.output : [];
    for (const rawItem of output) {
      if (!isRecord(rawItem)) {
        continue;
      }
      const itemId = readString(rawItem.id);
      if (itemId !== undefined && this.completedItemIds.has(itemId)) {
        continue;
      }
      const pending = itemId === undefined ? undefined : this.pendingById.get(itemId);
      if (pending !== undefined) {
        this.finishPending(pending, rawItem);
        continue;
      }
      const syntheticEvent = {
        output_index: this.nextSyntheticIndex++,
        item: rawItem,
        item_id: itemId,
      };
      this.addItem(syntheticEvent);
      const added = this.findPending(syntheticEvent);
      if (added !== undefined) {
        this.finishPending(added, rawItem);
      }
    }

    for (const pending of [...new Set(this.pendingByIndex.values())]) {
      this.finishPending(pending, pending.item);
    }

    const status = readString(response.status);
    if (status === "failed" || status === "cancelled") {
      throw new Error(
        readResponseError({ response }) ?? `${this.options.providerLabel} response ${status}.`,
      );
    }

    this.state.usage = readUsage(response.usage);
    this.state.stopReason =
      eventType === "response.incomplete" || status === "incomplete"
        ? "length"
        : this.message.content.some((content) => content.type === "tool_call")
          ? "toolUse"
          : "stop";
    this.state.terminalSeen = true;
  }

  private textAt(pending: PendingItem): string {
    const block = this.message.content[pending.contentIndex];
    return block?.type === "thinking" || block?.type === "text" ? block.text : "";
  }

  private findPending(event: Record<string, unknown>): PendingItem | undefined {
    const outputIndex = readOptionalOutputIndex(event);
    if (outputIndex !== undefined) {
      const pending = this.pendingByIndex.get(outputIndex);
      if (pending !== undefined) {
        return pending;
      }
    }
    const itemId = readString(event.item_id);
    return itemId === undefined ? undefined : this.pendingById.get(itemId);
  }
}

export async function readResponsesStream(
  response: Response,
  onEvent: (event: Record<string, unknown>) => void,
  providerLabel: string,
  onActivity?: () => void,
): Promise<void> {
  if (!response.body) {
    throw new Error(`${providerLabel} response does not contain a body.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        applySseFrame(frame, onEvent, providerLabel);
      }
    }

    buffer += decoder.decode();
    if (buffer) {
      applySseFrame(buffer, onEvent, providerLabel);
    }
    completed = true;
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

function applySseFrame(
  frame: string,
  onEvent: (event: Record<string, unknown>) => void,
  providerLabel: string,
): void {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") {
    return;
  }

  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch (error) {
    throw new Error(`${providerLabel} stream returned invalid JSON.`, { cause: error });
  }
  onEvent(requireRecord(event, `${providerLabel} stream event`));
}

function readUsage(value: unknown): ModelUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const promptTokens = readNumber(value.input_tokens) ?? 0;
  const completionTokens = readNumber(value.output_tokens) ?? 0;
  const details = isRecord(value.input_tokens_details) ? value.input_tokens_details : {};
  const outputDetails = isRecord(value.output_tokens_details) ? value.output_tokens_details : {};
  const cacheHitTokens = readNumber(details.cached_tokens) ?? 0;
  const reasoningTokens = readNumber(outputDetails.reasoning_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: readNumber(value.total_tokens) ?? promptTokens + completionTokens,
    promptCacheHitTokens: cacheHitTokens,
    promptCacheMissTokens: Math.max(0, promptTokens - cacheHitTokens),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function readReasoningText(item: Record<string, unknown>): string {
  const summary = readTextParts(item.summary);
  return summary || readTextParts(item.content);
}

function readMessageText(item: Record<string, unknown>): string | undefined {
  if (!Array.isArray(item.content)) {
    return undefined;
  }
  return item.content
    .filter(isRecord)
    .map((part) => readString(part.text) ?? readString(part.refusal) ?? "")
    .join("");
}

function readTextParts(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .filter(isRecord)
    .map((part) => readString(part.text) ?? "")
    .filter(Boolean)
    .join("\n\n");
}

function readResponseError(event: Record<string, unknown>): string | undefined {
  const response = isRecord(event.response) ? event.response : undefined;
  const error = response && isRecord(response.error) ? response.error : undefined;
  if (error !== undefined) {
    return readString(error.message) ?? readString(error.code);
  }
  const details =
    response && isRecord(response.incomplete_details) ? response.incomplete_details : undefined;
  return details === undefined ? undefined : readString(details.reason);
}

function createResponsesStreamError(
  event: Record<string, unknown>,
  eventType: "error" | "response.failed",
  message: string,
): ResponsesStreamError {
  const providerCode = readResponsesErrorCode(event);
  const response = isRecord(event.response) ? event.response : undefined;
  const error =
    response && isRecord(response.error)
      ? response.error
      : isRecord(event.error)
        ? event.error
        : event;
  return new ResponsesStreamError(
    eventType,
    isTransientResponsesError(message, providerCode),
    message,
    providerCode,
    readString(error.param),
  );
}

function readResponsesErrorCode(event: Record<string, unknown>): string | undefined {
  const response = isRecord(event.response) ? event.response : undefined;
  const responseError = response && isRecord(response.error) ? response.error : undefined;
  const eventError = isRecord(event.error) ? event.error : undefined;
  return (
    (responseError && (readString(responseError.code) ?? readString(responseError.type))) ??
    (eventError && (readString(eventError.code) ?? readString(eventError.type))) ??
    readString(event.code)
  );
}

const NON_RETRYABLE_RESPONSES_ERROR_CODES = new Set([
  "invalid_request_error",
  "invalid_parameter",
  "invalid_prompt",
  "unsupported_value",
  "authentication_error",
  "permission_error",
  "model_not_found",
  "not_found",
]);

const RETRYABLE_RESPONSES_ERROR_CODES = new Set([
  "internal_error",
  "server_error",
  "temporarily_unavailable",
  "overloaded",
  "rate_limit_exceeded",
]);

function isTransientResponsesError(message: string, code?: string): boolean {
  if (
    code === "subscription_sharing_usage_limit_exceeded" ||
    code === "subscription_sharing_user_not_eligible" ||
    code === "subscription_sharing_unsupported_capability"
  )
    return false;
  if (
    code === "subscription_sharing_usage_unavailable" ||
    code === "subscription_sharing_user_unavailable"
  )
    return true;
  const normalizedCode = code
    ?.trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (normalizedCode !== undefined && NON_RETRYABLE_RESPONSES_ERROR_CODES.has(normalizedCode)) {
    return false;
  }
  return (
    (normalizedCode !== undefined && RETRYABLE_RESPONSES_ERROR_CODES.has(normalizedCode)) ||
    /(?:currently\s+)?overloaded|temporarily unavailable|try again later/i.test(message)
  );
}

function readEventError(event: Record<string, unknown>): string | undefined {
  const error = isRecord(event.error) ? event.error : undefined;
  return (
    readString(event.message) ??
    (error ? readString(error.message) : undefined) ??
    readString(event.code) ??
    (error ? readString(error.code) : undefined)
  );
}

function parseToolArguments(value: string): unknown {
  if (!value) {
    return {};
  }
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function readHostedToolAction(value: unknown): HostedToolAction | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const type = readString(value.type);
  if (type === undefined) {
    return undefined;
  }
  const queries = Array.isArray(value.queries)
    ? value.queries.filter(
        (query): query is string => typeof query === "string" && query.length > 0,
      )
    : undefined;
  const query = readString(value.query);
  const url = readString(value.url);
  const pattern = readString(value.pattern);
  return {
    type,
    ...(query === undefined ? {} : { query }),
    ...(queries?.length ? { queries } : {}),
    ...(url === undefined ? {} : { url }),
    ...(pattern === undefined ? {} : { pattern }),
  };
}

function readOutputIndex(event: Record<string, unknown>, fallback: number): number {
  return readOptionalOutputIndex(event) ?? fallback;
}

function readOptionalOutputIndex(event: Record<string, unknown>): number | undefined {
  const value = event.output_index;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value;
}

function requireString(value: unknown, name: string): string {
  const string = readString(value);
  if (string === undefined) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return string;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
