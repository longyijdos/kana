import type { AssistantEventStream, AssistantMessage, ToolCallContent } from "@/core";
import type {
  OpenAICompatibleChunk,
  OpenAICompatibleStreamState,
  OpenAICompatibleToolCallDelta,
  PendingOpenAICompatibleToolCall,
} from "./types";

export async function readOpenAICompatibleStream(
  response: Response,
  onChunk: (chunk: OpenAICompatibleChunk) => void,
  onActivity?: () => void,
): Promise<void> {
  if (!response.body) {
    throw new Error("OpenAI-compatible provider response does not contain a body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    // Raw bytes, including heartbeats and partial SSE frames, prove that the
    // connection is active and refresh the inactivity deadline.
    onActivity?.();
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
      onChunk(JSON.parse(data) as OpenAICompatibleChunk);
    }
  }

  buffer += decoder.decode();
  const data = parseSseData(buffer);
  if (data && data !== "[DONE]") {
    onChunk(JSON.parse(data) as OpenAICompatibleChunk);
  }
}

export function applyOpenAICompatibleChunk(
  stream: AssistantEventStream,
  message: AssistantMessage,
  state: OpenAICompatibleStreamState,
  chunk: OpenAICompatibleChunk,
): void {
  if (chunk.error !== undefined) {
    throw new Error("OpenAI-compatible provider returned an error event in its completion stream.");
  }
  if (chunk.usage) {
    state.usage = toModelUsage(chunk.usage);
  }

  for (const choice of chunk.choices ?? []) {
    // Kana requests one completion. Ignore defensive extra choices instead of
    // interleaving independent assistant messages into one core message.
    if ((choice.index ?? 0) !== 0) {
      continue;
    }

    if (choice.delta?.content) {
      applyTextDelta(stream, message, state, choice.delta.content);
    }
    for (const toolCallDelta of choice.delta?.tool_calls ?? []) {
      applyToolCallDelta(stream, message, state, toolCallDelta);
    }
    if (choice.finish_reason) {
      state.finishReason = choice.finish_reason;
      if (!isSupportedFinishReason(choice.finish_reason)) {
        throw new Error(
          `OpenAI-compatible provider stream finished with unsupported reason ${choice.finish_reason}.`,
        );
      }
    }
  }
}

export function finishOpenAICompatibleContent(
  stream: AssistantEventStream,
  message: AssistantMessage,
  state: OpenAICompatibleStreamState,
): void {
  for (let contentIndex = 0; contentIndex < message.content.length; contentIndex += 1) {
    if (state.endedContentIndexes.has(contentIndex)) {
      continue;
    }
    const content = message.content[contentIndex];
    if (content.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex,
        content: content.text,
        snapshot: structuredClone(message),
      });
      state.endedContentIndexes.add(contentIndex);
    }
  }
}

export function finishOpenAICompatibleToolCalls(
  stream: AssistantEventStream,
  message: AssistantMessage,
  state: OpenAICompatibleStreamState,
): void {
  for (let contentIndex = 0; contentIndex < message.content.length; contentIndex += 1) {
    const content = message.content[contentIndex];
    if (content.type === "tool_call" && !state.endedContentIndexes.has(contentIndex)) {
      finishToolCall(stream, message, state, contentIndex, content);
    }
  }
}

export function getOpenAICompatibleDoneReason(
  finishReason: string | undefined,
): "stop" | "length" | "toolUse" {
  switch (finishReason) {
    case "length":
      return "length";
    case "tool_calls":
      return "toolUse";
    case "stop":
    case undefined:
      return "stop";
    default:
      throw new Error(
        `OpenAI-compatible provider stream finished with unsupported reason ${finishReason}.`,
      );
  }
}

function parseSseData(part: string): string | undefined {
  if (!part) {
    return undefined;
  }
  const dataLines = part
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());
  return dataLines.length ? dataLines.join("\n") : undefined;
}

function applyTextDelta(
  stream: AssistantEventStream,
  message: AssistantMessage,
  state: OpenAICompatibleStreamState,
  delta: string,
): void {
  let contentIndex = message.content.findIndex(
    (content, index) => content.type === "text" && !state.endedContentIndexes.has(index),
  );
  if (contentIndex === -1) {
    contentIndex = message.content.length;
    message.content.push({ type: "text", text: "" });
    stream.push({ type: "text_start", contentIndex, snapshot: structuredClone(message) });
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
  stream: AssistantEventStream,
  message: AssistantMessage,
  state: OpenAICompatibleStreamState,
  delta: OpenAICompatibleToolCallDelta,
): void {
  finishOpenAICompatibleContent(stream, message, state);
  const toolCallIndex = delta.index ?? 0;
  const pending = getPendingToolCall(message, toolCallIndex);

  if (delta.id) {
    pending.toolCall.id = delta.id;
  }
  if (delta.function?.name) {
    pending.toolCall.name += delta.function.name;
  }
  if (pending.isNew) {
    finishToolCallsBeforeIndex(stream, message, state, toolCallIndex);
    stream.push({
      type: "toolcall_start",
      contentIndex: pending.contentIndex,
      snapshot: structuredClone(message),
    });
  }
  if (delta.function?.arguments) {
    pending.toolCall.rawArgs = (pending.toolCall.rawArgs ?? "") + delta.function.arguments;
    stream.push({
      type: "toolcall_delta",
      contentIndex: pending.contentIndex,
      delta: delta.function.arguments,
      snapshot: structuredClone(message),
    });
  }
}

function finishToolCallsBeforeIndex(
  stream: AssistantEventStream,
  message: AssistantMessage,
  state: OpenAICompatibleStreamState,
  toolCallIndex: number,
): void {
  let currentIndex = 0;
  for (let contentIndex = 0; contentIndex < message.content.length; contentIndex += 1) {
    const content = message.content[contentIndex];
    if (content.type !== "tool_call") {
      continue;
    }
    if (currentIndex >= toolCallIndex) {
      return;
    }
    if (!state.endedContentIndexes.has(contentIndex)) {
      finishToolCall(stream, message, state, contentIndex, content);
    }
    currentIndex += 1;
  }
}

function finishToolCall(
  stream: AssistantEventStream,
  message: AssistantMessage,
  state: OpenAICompatibleStreamState,
  contentIndex: number,
  toolCall: ToolCallContent,
): void {
  if (!toolCall.id || !toolCall.name) {
    throw new Error("OpenAI-compatible provider returned an incomplete tool call.");
  }
  toolCall.args = parseToolArguments(toolCall.rawArgs ?? "");
  stream.push({
    type: "toolcall_end",
    contentIndex,
    toolCall: structuredClone(toolCall),
    snapshot: structuredClone(message),
  });
  state.endedContentIndexes.add(contentIndex);
}

function getPendingToolCall(
  message: AssistantMessage,
  toolCallIndex: number,
): PendingOpenAICompatibleToolCall {
  const existing = message.content.filter((content) => content.type === "tool_call")[toolCallIndex];
  if (existing?.type === "tool_call") {
    return {
      contentIndex: message.content.indexOf(existing),
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
  return { contentIndex, isNew: true, toolCall };
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

function toModelUsage(
  usage: NonNullable<OpenAICompatibleChunk["usage"]>,
): OpenAICompatibleStreamState["usage"] {
  const promptTokens = readTokenCount(usage.prompt_tokens, "prompt_tokens");
  const completionTokens = readTokenCount(usage.completion_tokens, "completion_tokens");
  const totalTokens = readTokenCount(usage.total_tokens, "total_tokens");
  const cachedTokens = readOptionalTokenCount(
    usage.prompt_tokens_details?.cached_tokens,
    "prompt_tokens_details.cached_tokens",
  );

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cachedTokens === undefined
      ? {}
      : {
          promptCacheHitTokens: cachedTokens,
          promptCacheMissTokens: Math.max(0, promptTokens - cachedTokens),
        }),
    reasoningTokens: readOptionalTokenCount(
      usage.completion_tokens_details?.reasoning_tokens,
      "completion_tokens_details.reasoning_tokens",
    ),
  };
}

function readTokenCount(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`OpenAI-compatible provider returned invalid usage.${name}.`);
  }
  return value;
}

function readOptionalTokenCount(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : readTokenCount(value, name);
}

function isSupportedFinishReason(value: string): boolean {
  return value === "stop" || value === "length" || value === "tool_calls";
}
