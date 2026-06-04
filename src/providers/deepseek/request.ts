import type { ModelContext } from "../../core/context";
import type {
  AgentMessage,
  AssistantContent,
  ToolCallContent,
} from "../../core/messages";
import type { ToolSpec } from "../../tools/tool";
import type {
  DeepSeekMessage,
  DeepSeekModelConfig,
  DeepSeekTool,
  DeepSeekToolCall,
} from "./types";

export function buildDeepSeekRequest(
  context: ModelContext,
  config: DeepSeekModelConfig,
): Record<string, unknown> {
  // Non-streaming generation is implemented by BaseModel.generate(), so the
  // model always uses DeepSeek's streaming endpoint shape.
  const request: Record<string, unknown> = {
    model: config.model,
    messages: toDeepSeekMessages(context),
    stream: true,
  };

  if (config.temperature !== undefined) {
    request.temperature = config.temperature;
  }

  if (config.maxTokens !== undefined) {
    request.max_tokens = config.maxTokens;
  }

  if (config.topP !== undefined) {
    request.top_p = config.topP;
  }

  if (config.thinking !== undefined) {
    request.thinking = {
      type: config.thinking ? "enabled" : "disabled",
    };
  }

  if (config.reasoningEffort !== undefined) {
    request.reasoning_effort = config.reasoningEffort;
  }

  if (config.responseFormat !== undefined) {
    request.response_format = config.responseFormat;
  }

  if (config.userId !== undefined) {
    request.user_id = config.userId;
  }

  if (context.tools?.length) {
    request.tools = toDeepSeekTools(context.tools, config.strictTools ?? false);
    request.tool_choice = config.toolChoice ?? "auto";
  } else if (config.toolChoice !== undefined) {
    request.tool_choice = config.toolChoice;
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
