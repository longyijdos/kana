import type {
  AssistantEventStream,
  AssistantMessage,
  ModelUsage,
  TextContent,
  ThinkingContent,
  ToolCallContent,
} from "@/core";
import type { OpenAICodexStreamState } from "./types";

type PendingItem =
  | {
      kind: "reasoning";
      contentIndex: number;
      content: ThinkingContent;
      item: Record<string, unknown>;
    }
  | {
      kind: "message";
      contentIndex: number;
      content: TextContent;
      item: Record<string, unknown>;
    }
  | {
      kind: "function_call";
      contentIndex: number;
      content: ToolCallContent;
      item: Record<string, unknown>;
    };

export class OpenAICodexStreamProcessor {
  private readonly pendingByIndex = new Map<number, PendingItem>();
  private readonly pendingById = new Map<string, PendingItem>();
  private readonly completedItemIds = new Set<string>();
  private nextSyntheticIndex = 0;

  constructor(
    private readonly stream: AssistantEventStream,
    private readonly message: AssistantMessage,
    private readonly state: OpenAICodexStreamState,
  ) {}

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
        throw new Error(readResponseError(event) ?? "OpenAI Codex response failed.");
      case "error":
        throw new Error(readEventError(event) ?? "OpenAI Codex stream returned an error.");
      default:
        return;
    }
  }

  private addItem(event: Record<string, unknown>): void {
    const item = requireRecord(event.item, "OpenAI Codex output item");
    const outputIndex = readOutputIndex(event, this.nextSyntheticIndex++);
    const itemId = readString(item.id);
    if (itemId !== undefined && this.completedItemIds.has(itemId)) {
      return;
    }
    if (this.pendingByIndex.has(outputIndex)) {
      return;
    }

    const contentIndex = this.message.content.length;
    const type = readString(item.type);
    let pending: PendingItem;
    if (type === "reasoning") {
      const content: ThinkingContent = { type: "thinking", text: "" };
      this.message.content.push(content);
      pending = { kind: "reasoning", contentIndex, content, item: structuredClone(item) };
      this.stream.push({
        type: "thinking_start",
        contentIndex,
        snapshot: structuredClone(this.message),
      });
    } else if (type === "message") {
      const content: TextContent = { type: "text", text: "" };
      this.message.content.push(content);
      pending = { kind: "message", contentIndex, content, item: structuredClone(item) };
      this.stream.push({
        type: "text_start",
        contentIndex,
        snapshot: structuredClone(this.message),
      });
    } else if (type === "function_call") {
      const rawArgs = readString(item.arguments) ?? "";
      const content: ToolCallContent = {
        type: "tool_call",
        id: requireString(item.call_id, "OpenAI Codex function call ID"),
        name: requireString(item.name, "OpenAI Codex function name"),
        args: parseToolArguments(rawArgs),
        rawArgs,
      };
      this.message.content.push(content);
      pending = { kind: "function_call", contentIndex, content, item: structuredClone(item) };
      this.stream.push({
        type: "toolcall_start",
        contentIndex,
        snapshot: structuredClone(this.message),
      });
    } else {
      return;
    }

    this.pendingByIndex.set(outputIndex, pending);
    if (itemId !== undefined) {
      this.pendingById.set(itemId, pending);
    }
  }

  private applyThinkingDelta(event: Record<string, unknown>): void {
    const pending = this.findPending(event);
    const delta = readString(event.delta);
    if (pending?.kind !== "reasoning" || !delta) {
      return;
    }
    pending.content.text += delta;
    this.stream.push({
      type: "thinking_delta",
      contentIndex: pending.contentIndex,
      delta,
      snapshot: structuredClone(this.message),
    });
  }

  private finishThinkingPart(event: Record<string, unknown>): void {
    const pending = this.findPending(event);
    if (pending?.kind !== "reasoning" || !pending.content.text) {
      return;
    }
    const delta = "\n\n";
    pending.content.text += delta;
    this.stream.push({
      type: "thinking_delta",
      contentIndex: pending.contentIndex,
      delta,
      snapshot: structuredClone(this.message),
    });
  }

  private applyTextDelta(event: Record<string, unknown>): void {
    const pending = this.findPending(event);
    const delta = readString(event.delta);
    if (pending?.kind !== "message" || !delta) {
      return;
    }
    pending.content.text += delta;
    this.stream.push({
      type: "text_delta",
      contentIndex: pending.contentIndex,
      delta,
      snapshot: structuredClone(this.message),
    });
  }

  private applyToolCallDelta(event: Record<string, unknown>): void {
    const pending = this.findPending(event);
    const delta = readString(event.delta);
    if (pending?.kind !== "function_call" || !delta) {
      return;
    }
    pending.content.rawArgs = (pending.content.rawArgs ?? "") + delta;
    pending.content.args = parseToolArguments(pending.content.rawArgs);
    this.stream.push({
      type: "toolcall_delta",
      contentIndex: pending.contentIndex,
      delta,
      snapshot: structuredClone(this.message),
    });
  }

  private applyToolCallArgumentsDone(event: Record<string, unknown>): void {
    const pending = this.findPending(event);
    const rawArgs = readString(event.arguments);
    if (pending?.kind !== "function_call" || rawArgs === undefined) {
      return;
    }
    const previous = pending.content.rawArgs ?? "";
    pending.content.rawArgs = rawArgs;
    pending.content.args = parseToolArguments(rawArgs);
    if (rawArgs.startsWith(previous) && rawArgs.length > previous.length) {
      const delta = rawArgs.slice(previous.length);
      this.stream.push({
        type: "toolcall_delta",
        contentIndex: pending.contentIndex,
        delta,
        snapshot: structuredClone(this.message),
      });
    }
  }

  private completeItem(event: Record<string, unknown>): void {
    const item = requireRecord(event.item, "OpenAI Codex completed output item");
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
    pending.content.providerState = {
      provider: "openai-codex",
      value: structuredClone(item),
    };

    if (pending.kind === "reasoning") {
      pending.content.text = readReasoningText(item) || pending.content.text.replace(/\n\n$/, "");
      this.stream.push({
        type: "thinking_end",
        contentIndex: pending.contentIndex,
        content: pending.content.text,
        snapshot: structuredClone(this.message),
      });
    } else if (pending.kind === "message") {
      pending.content.text = readMessageText(item) ?? pending.content.text;
      this.stream.push({
        type: "text_end",
        contentIndex: pending.contentIndex,
        content: pending.content.text,
        snapshot: structuredClone(this.message),
      });
    } else {
      const rawArgs = readString(item.arguments) ?? pending.content.rawArgs ?? "";
      pending.content.id = readString(item.call_id) ?? pending.content.id;
      pending.content.name = readString(item.name) ?? pending.content.name;
      pending.content.rawArgs = rawArgs;
      pending.content.args = parseToolArguments(rawArgs);
      this.stream.push({
        type: "toolcall_end",
        contentIndex: pending.contentIndex,
        toolCall: structuredClone(pending.content),
        snapshot: structuredClone(this.message),
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
      throw new Error(readResponseError({ response }) ?? `OpenAI Codex response ${status}.`);
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

export async function readOpenAICodexStream(
  response: Response,
  onEvent: (event: Record<string, unknown>) => void,
  onActivity?: () => void,
): Promise<void> {
  if (!response.body) {
    throw new Error("OpenAI Codex response does not contain a body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
      applySseFrame(frame, onEvent);
    }
  }

  buffer += decoder.decode();
  if (buffer) {
    applySseFrame(buffer, onEvent);
  }
}

function applySseFrame(frame: string, onEvent: (event: Record<string, unknown>) => void): void {
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
    throw new Error("OpenAI Codex stream returned invalid JSON.", { cause: error });
  }
  onEvent(requireRecord(event, "OpenAI Codex stream event"));
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
  return {
    promptTokens,
    completionTokens,
    totalTokens: readNumber(value.total_tokens) ?? promptTokens + completionTokens,
    promptCacheHitTokens: cacheHitTokens,
    promptCacheMissTokens: Math.max(0, promptTokens - cacheHitTokens),
    ...(readNumber(outputDetails.reasoning_tokens) === undefined
      ? {}
      : { reasoningTokens: readNumber(outputDetails.reasoning_tokens) }),
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

function readEventError(event: Record<string, unknown>): string | undefined {
  return readString(event.message) ?? readString(event.code);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
