import type { AgentMessage } from "./messages";
import type { ToolSpec } from "../tools/tool";

export type ModelContext = {
  system?: string;
  messages: AgentMessage[];
  tools?: ToolSpec[];
};
