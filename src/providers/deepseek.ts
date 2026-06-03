import type { ModelContext } from "../core/context";
import type { ModelOptions, ModelProvider } from "../core/model";
import type {
  AgentMessage,
  AssistantContent,
  AssistantMessage,
  ToolCallContent,
} from "../core/messages";
import { AssistantMessageStream } from "../core/stream";
import type { ToolSpec } from "../tools/tool";
import { registerProvider } from "./registry";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-pro";

export type DeepSeekReasoningEffort = "high" | "max";

export type DeepSeekToolChoice =
  | "none"
  | "auto"
  | "required"
  | {
      type: "function";
      function: {
        name: string;
      };
    };

export type DeepSeekResponseFormat =
  | {
      type: "text";
    }
  | {
      type: "json_object";
    };

export type DeepSeekModelOptions = ModelOptions & {
  thinking?: boolean;
  reasoningEffort?: DeepSeekReasoningEffort;
  topP?: number;
  toolChoice?: DeepSeekToolChoice;
  responseFormat?: DeepSeekResponseFormat;
  userId?: string;
  strictTools?: boolean;
};

type DeepSeekMessage =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string;
      reasoning_content?: string;
      tool_calls?: DeepSeekToolCall[];
    }
  | {
      role: "tool";
      content: string;
      tool_call_id: string;
    };

type DeepSeekTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
    strict?: boolean;
  };
};

type DeepSeekToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type DeepSeekChatCompletionChunk = {
  choices?: Array<{
    delta?: {
      role?: "assistant" | null;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: DeepSeekToolCallDelta[];
    };
    finish_reason?: DeepSeekFinishReason | null;
  }>;
};

type DeepSeekFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "insufficient_system_resource";

type DeepSeekToolCallDelta = {
  index?: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
};

type PendingToolCall = {
  contentIndex: number;
  isNew: boolean;
  toolCall: ToolCallContent;
};

type DeepSeekStreamState = {
  finishReason?: DeepSeekFinishReason;
  endedContentIndexes: Set<number>;
};

class DeepSeekHttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly body: string,
  ) {
    super(`DeepSeek API request failed with ${status} ${statusText}: ${body}`);
  }
}

export class DeepSeekModelProvider
  implements ModelProvider<DeepSeekModelOptions>
{
  stream(
    context: ModelContext,
    options: DeepSeekModelOptions = {},
  ): AssistantMessageStream {
    const stream = new AssistantMessageStream();

    // The provider contract is synchronous: return the stream immediately and
    // let the request lifecycle write events into it asynchronously.
    void this.run(stream, context, options);

    return stream;
  }

  private async run(
    stream: AssistantMessageStream,
    context: ModelContext,
    options: DeepSeekModelOptions,
  ): Promise<void> {
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
    };
    const state: DeepSeekStreamState = {
      endedContentIndexes: new Set<number>(),
    };

    try {
      const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;

      if (!apiKey) {
        throw new Error(
          "DeepSeek API key is required. Pass options.apiKey or set DEEPSEEK_API_KEY.",
        );
      }

      const request = buildDeepSeekRequest(context, options);
      const requestSignal = createRequestSignal(options);

      try {
        const response = await fetchWithRetries(
          joinUrl(options.baseUrl ?? DEFAULT_BASE_URL, "/chat/completions"),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "text/event-stream",
              authorization: `Bearer ${apiKey}`,
              ...options.headers,
            },
            body: JSON.stringify(request),
            signal: requestSignal.signal,
          },
          options.maxRetries ?? 0,
        );

        stream.push({
          type: "start",
          snapshot: structuredClone(message),
        });

        await readDeepSeekStream(response, (chunk) => {
          applyChunk(stream, message, state, chunk);
        });

        finishOpenContent(stream, message, state);

        if (state.finishReason === "tool_calls") {
          finishToolCalls(stream, message, state);
        }

        stream.end({
          type: "done",
          reason: getDoneReason(state.finishReason),
          message: structuredClone(message),
        });
      } finally {
        requestSignal.dispose();
      }
    } catch (error) {
      stream.error({
        type: "error",
        reason: isAbortError(error) || options.signal?.aborted ? "aborted" : "error",
        error,
        snapshot: structuredClone(message),
      });
    }
  }
}

export const deepSeekProvider = new DeepSeekModelProvider();

registerProvider("deepseek", deepSeekProvider);

function buildDeepSeekRequest(
  context: ModelContext,
  options: DeepSeekModelOptions,
): Record<string, unknown> {
  // Non-streaming generation is implemented by core/model.generate(), so the
  // provider always uses DeepSeek's streaming endpoint shape.
  const request: Record<string, unknown> = {
    model: options.model ?? DEFAULT_MODEL,
    messages: toDeepSeekMessages(context),
    stream: true,
  };

  if (options.temperature !== undefined) {
    request.temperature = options.temperature;
  }

  if (options.maxTokens !== undefined) {
    request.max_tokens = options.maxTokens;
  }

  if (options.topP !== undefined) {
    request.top_p = options.topP;
  }

  if (options.thinking !== undefined) {
    request.thinking = {
      type: options.thinking ? "enabled" : "disabled",
    };
  }

  if (options.reasoningEffort !== undefined) {
    request.reasoning_effort = options.reasoningEffort;
  }

  if (options.responseFormat !== undefined) {
    request.response_format = options.responseFormat;
  }

  if (options.userId !== undefined) {
    request.user_id = options.userId;
  }

  if (context.tools?.length) {
    request.tools = toDeepSeekTools(context.tools, options.strictTools ?? false);
    request.tool_choice = options.toolChoice ?? "auto";
  } else if (options.toolChoice !== undefined) {
    request.tool_choice = options.toolChoice;
  }

  return request;
}

function toDeepSeekMessages(context: ModelContext): DeepSeekMessage[] {
  const messages: DeepSeekMessage[] = [];

  // Keep system outside AgentMessage for now, but send it as a normal
  // DeepSeek/OpenAI-compatible system message.
  if (context.system) {
    messages.push({
      role: "system",
      content: context.system,
    });
  }

  for (const message of context.messages) {
    messages.push(toDeepSeekMessage(message));
  }

  return messages;
}

function toDeepSeekMessage(message: AgentMessage): DeepSeekMessage {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        content: message.content,
      };
    case "tool":
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId,
      };
    case "assistant":
      return toDeepSeekAssistantMessage(message.content);
  }
}

function toDeepSeekAssistantMessage(
  content: AssistantContent[],
): DeepSeekMessage {
  // DeepSeek stores visible text and reasoning content on separate fields, but
  // our assistant message keeps both as ordered content blocks.
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const reasoningContent = content
    .filter((block) => block.type === "thinking")
    .map((block) => block.text)
    .join("");
  const toolCalls = content
    .filter((block) => block.type === "tool_call")
    .map(toDeepSeekToolCall);

  return {
    role: "assistant",
    content: text,
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

function toDeepSeekToolCall(content: ToolCallContent): DeepSeekToolCall {
  return {
    id: content.id,
    type: "function",
    function: {
      name: content.name,
      arguments: content.rawArgs ?? JSON.stringify(content.args),
    },
  };
}

function toDeepSeekTools(
  tools: ToolSpec[],
  strict: boolean,
): DeepSeekTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(strict ? { strict: true } : {}),
    },
  }));
}

async function fetchWithRetries(
  url: string,
  init: RequestInit,
  maxRetries: number,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, init);

      if (response.ok) {
        return response;
      }

      const body = await response.text().catch(() => "");
      throw new DeepSeekHttpError(
        response.status,
        response.statusText,
        body,
      );
    } catch (error) {
      if (
        isAbortError(error) ||
        !isRetryableError(error) ||
        attempt >= maxRetries
      ) {
        throw error;
      }
    }

    await sleep(retryDelayMs(attempt), init.signal);
  }
}

async function readDeepSeekStream(
  response: Response,
  onChunk: (chunk: DeepSeekChatCompletionChunk) => void,
): Promise<void> {
  if (!response.body) {
    throw new Error("DeepSeek API response does not contain a body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // SSE frames are separated by a blank line. Chunks can split frames, so keep
  // the trailing partial frame in buffer between reads.
  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const data = parseSseData(part);

      if (!data) {
        continue;
      }

      if (data === "[DONE]") {
        return;
      }

      onChunk(JSON.parse(data) as DeepSeekChatCompletionChunk);
    }
  }

  buffer += decoder.decode();

  if (buffer) {
    const data = parseSseData(buffer);

    if (data && data !== "[DONE]") {
      onChunk(JSON.parse(data) as DeepSeekChatCompletionChunk);
    }
  }
}

function parseSseData(part: string): string | undefined {
  const lines = part.split(/\r?\n/);
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());

  if (!dataLines.length) {
    return undefined;
  }

  return dataLines.join("\n");
}

function applyChunk(
  stream: AssistantMessageStream,
  message: AssistantMessage,
  state: DeepSeekStreamState,
  chunk: DeepSeekChatCompletionChunk,
): void {
  for (const choice of chunk.choices ?? []) {
    const delta = choice.delta;

    if (delta?.reasoning_content) {
      applyThinkingDelta(stream, message, state, delta.reasoning_content);
    }

    if (delta?.content) {
      applyTextDelta(stream, message, state, delta.content);
    }

    for (const toolCallDelta of delta?.tool_calls ?? []) {
      applyToolCallDelta(stream, message, state, toolCallDelta);
    }

    if (choice.finish_reason) {
      state.finishReason = choice.finish_reason;

      if (
        choice.finish_reason === "content_filter" ||
        choice.finish_reason === "insufficient_system_resource"
      ) {
        throw new Error(`DeepSeek stream finished with ${choice.finish_reason}.`);
      }
    }
  }
}

function applyThinkingDelta(
  stream: AssistantMessageStream,
  message: AssistantMessage,
  state: DeepSeekStreamState,
  delta: string,
): void {
  let contentIndex = findOpenContentIndex(message, state, "thinking");

  if (contentIndex === -1) {
    contentIndex = message.content.length;
    message.content.push({
      type: "thinking",
      text: "",
    });

    stream.push({
      type: "thinking_start",
      contentIndex,
      snapshot: structuredClone(message),
    });
  }

  const content = message.content[contentIndex];

  if (content.type !== "thinking") {
    throw new Error("Internal error: expected thinking content.");
  }

  content.text += delta;

  stream.push({
    type: "thinking_delta",
    contentIndex,
    delta,
    snapshot: structuredClone(message),
  });
}

function applyTextDelta(
  stream: AssistantMessageStream,
  message: AssistantMessage,
  state: DeepSeekStreamState,
  delta: string,
): void {
  // Once visible text starts, the current reasoning block is complete.
  finishContentOfType(stream, message, state, "thinking");

  let contentIndex = findOpenContentIndex(message, state, "text");

  if (contentIndex === -1) {
    contentIndex = message.content.length;
    message.content.push({
      type: "text",
      text: "",
    });

    stream.push({
      type: "text_start",
      contentIndex,
      snapshot: structuredClone(message),
    });
  }

  const content = message.content[contentIndex];

  if (content.type !== "text") {
    throw new Error("Internal error: expected text content.");
  }

  content.text += delta;

  stream.push({
    type: "text_delta",
    contentIndex,
    delta,
    snapshot: structuredClone(message),
  });
}

function applyToolCallDelta(
  stream: AssistantMessageStream,
  message: AssistantMessage,
  state: DeepSeekStreamState,
  delta: DeepSeekToolCallDelta,
): void {
  // Tool calls are separate assistant content blocks, so close any active text
  // or reasoning block before starting one.
  finishContentOfType(stream, message, state, "thinking");
  finishContentOfType(stream, message, state, "text");

  const toolCall = getPendingToolCall(message, delta.index ?? 0);

  if (delta.id) {
    toolCall.toolCall.id = delta.id;
  }

  if (delta.function?.name) {
    toolCall.toolCall.name += delta.function.name;
  }

  if (toolCall.isNew) {
    stream.push({
      type: "toolcall_start",
      contentIndex: toolCall.contentIndex,
      snapshot: structuredClone(message),
    });
  }

  if (delta.function?.arguments) {
    toolCall.toolCall.rawArgs =
      (toolCall.toolCall.rawArgs ?? "") + delta.function.arguments;

    stream.push({
      type: "toolcall_delta",
      contentIndex: toolCall.contentIndex,
      delta: delta.function.arguments,
      snapshot: structuredClone(message),
    });
  }
}

function getPendingToolCall(
  message: AssistantMessage,
  toolCallIndex: number,
): PendingToolCall {
  const existing = message.content.filter(
    (content) => content.type === "tool_call",
  )[toolCallIndex];

  if (existing?.type === "tool_call") {
    const contentIndex = message.content.indexOf(existing);

    return {
      contentIndex,
      isNew: false,
      toolCall: existing,
    };
  }

  const contentIndex = message.content.length;
  const toolCall: ToolCallContent = {
    type: "tool_call",
    id: "",
    name: "",
    args: undefined,
    rawArgs: "",
  };

  message.content.push(toolCall);

  return {
    contentIndex,
    isNew: true,
    toolCall,
  };
}

function findOpenContentIndex(
  message: AssistantMessage,
  state: DeepSeekStreamState,
  type: "thinking" | "text",
): number {
  return message.content.findIndex(
    (content, contentIndex) =>
      content.type === type && !state.endedContentIndexes.has(contentIndex),
  );
}

function finishContentOfType(
  stream: AssistantMessageStream,
  message: AssistantMessage,
  state: DeepSeekStreamState,
  type: "thinking" | "text",
): void {
  for (let contentIndex = 0; contentIndex < message.content.length; contentIndex += 1) {
    if (state.endedContentIndexes.has(contentIndex)) {
      continue;
    }

    const content = message.content[contentIndex];

    if (content.type !== type) {
      continue;
    }

    switch (content.type) {
      case "thinking":
        stream.push({
          type: "thinking_end",
          contentIndex,
          content: content.text,
          snapshot: structuredClone(message),
        });
        break;
      case "text":
        stream.push({
          type: "text_end",
          contentIndex,
          content: content.text,
          snapshot: structuredClone(message),
        });
        break;
    }

    state.endedContentIndexes.add(contentIndex);
  }
}

function finishOpenContent(
  stream: AssistantMessageStream,
  message: AssistantMessage,
  state: DeepSeekStreamState,
): void {
  for (let contentIndex = 0; contentIndex < message.content.length; contentIndex += 1) {
    if (state.endedContentIndexes.has(contentIndex)) {
      continue;
    }

    const content = message.content[contentIndex];

    switch (content.type) {
      case "thinking":
        stream.push({
          type: "thinking_end",
          contentIndex,
          content: content.text,
          snapshot: structuredClone(message),
        });
        state.endedContentIndexes.add(contentIndex);
        break;
      case "text":
        stream.push({
          type: "text_end",
          contentIndex,
          content: content.text,
          snapshot: structuredClone(message),
        });
        state.endedContentIndexes.add(contentIndex);
        break;
      case "tool_call":
        break;
    }
  }
}

function finishToolCalls(
  stream: AssistantMessageStream,
  message: AssistantMessage,
  state: DeepSeekStreamState,
): void {
  for (let contentIndex = 0; contentIndex < message.content.length; contentIndex += 1) {
    if (state.endedContentIndexes.has(contentIndex)) {
      continue;
    }

    const content = message.content[contentIndex];

    if (content.type !== "tool_call") {
      continue;
    }

    content.args = parseToolArguments(content.rawArgs ?? "");

    stream.push({
      type: "toolcall_end",
      contentIndex,
      toolCall: structuredClone(content),
      snapshot: structuredClone(message),
    });
    state.endedContentIndexes.add(contentIndex);
  }
}

function parseToolArguments(rawArgs: string): unknown {
  if (!rawArgs) {
    return {};
  }

  try {
    return JSON.parse(rawArgs);
  } catch {
    return rawArgs;
  }
}

function getDoneReason(
  finishReason: DeepSeekFinishReason | undefined,
): "stop" | "length" | "toolUse" {
  switch (finishReason) {
    case "length":
      return "length";
    case "tool_calls":
      return "toolUse";
    case "stop":
    case undefined:
      return "stop";
    case "content_filter":
    case "insufficient_system_resource":
      throw new Error(`DeepSeek stream finished with ${finishReason}.`);
  }
}

function createRequestSignal(options: DeepSeekModelOptions): {
  signal?: AbortSignal;
  dispose(): void;
} {
  if (!options.timeoutMs) {
    return {
      signal: options.signal,
      dispose() {},
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`DeepSeek request timed out after ${options.timeoutMs}ms.`));
  }, options.timeoutMs);
  const abort = (): void => {
    controller.abort(options.signal?.reason);
  };

  if (options.signal?.aborted) {
    abort();
  } else {
    options.signal?.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    },
  };
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof DeepSeekHttpError) {
    return shouldRetryStatus(error.status);
  }

  return true;
}

function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 8000);
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = (): void => {
      cleanup();
      reject(signal?.reason);
    };

    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  );
}
