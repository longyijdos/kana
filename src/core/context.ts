import type { Message } from "./messages";
import type { ToolSpec } from "./tool";

// Provider-facing invocation context. Model/network settings live in
// ModelConfig; signal is per-run execution state so callers can cancel an
// in-flight model request.
export type ModelContext = {
  system?: string;
  messages: Message[];
  tools?: ToolSpec[];
  parallelToolCalls?: boolean;
  // Per-request completion ceiling after the caller accounts for the prompt.
  // Providers decide whether and how their wire protocol can express it.
  maxOutputTokens?: number;
  signal?: AbortSignal;
};
