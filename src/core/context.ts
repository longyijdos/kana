import type { AgentMessage } from "./messages";
import type { ToolSpec } from "../tools/tool";

// Provider-facing context only. Per-call model/network settings live in
// ModelOptions instead of being mixed into the conversation state.
export type ModelContext = {
  system?: string;
  messages: AgentMessage[];
  tools?: ToolSpec[];
};
