import type { Message } from "./messages";
import type { ToolSpec } from "@/tools";

// Provider-facing invocation context. Model/network settings live in
// ModelConfig; signal is per-run execution state so callers can cancel an
// in-flight model request.
export type ModelContext = {
  system?: string;
  messages: Message[];
  tools?: ToolSpec[];
  signal?: AbortSignal;
};
