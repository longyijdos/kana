import {
  AssistantEventStream,
  type AssistantMessage,
  type ToolCallContent,
} from "@/core";
import type {
  DeepSeekChatCompletionChunk,
  DeepSeekFinishReason,
  DeepSeekStreamState,
  DeepSeekToolCallDelta,
  PendingToolCall,
} from "./types";

export async function readDeepSeekStream(
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

export function applyDeepSeekChunk(
  stream: AssistantEventStream,
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

export function finishOpenContent(
  stream: AssistantEventStream,
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

export function finishToolCalls(
  stream: AssistantEventStream,
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

export function getDoneReason(
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

function applyThinkingDelta(
  stream: AssistantEventStream,
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
  stream: AssistantEventStream,
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
  stream: AssistantEventStream,
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
  stream: AssistantEventStream,
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
