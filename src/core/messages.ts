export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

export type UserMessage = {
  role: "user";
  content: string;
};

export type AssistantMessage = {
  role: "assistant";
  content: AssistantContent[];
};

export type ToolResultMessage = {
  role: "tool";
  toolCallId: string;
  toolName: string;
  content: string;
  result?: unknown;
  isError: boolean;
};

export type AssistantContent = TextContent | ThinkingContent | ToolCallContent;

export type TextContent = {
  type: "text";
  text: string;
};

export type ThinkingContent = {
  type: "thinking";
  text: string;
};

export type ToolCallContent = {
  type: "tool_call";
  id: string;
  name: string;
  args: unknown;
  rawArgs?: string;
};
