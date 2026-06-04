import type { AgentMessage } from "./messages";
import type { ToolSpec } from "../tools/tool";

// Provider-facing context only. Model/network settings live in ModelConfig
// instead of being mixed into conversation state.
export type ModelContext = {
  system?: string;
  messages: AgentMessage[];
  tools?: ToolSpec[];
};
