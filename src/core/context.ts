import type { Message } from "./messages";
import type { ToolSpec } from "./tool";

// Provider-facing invocation context. Static transport settings live in
// ModelConfig; per-Agent policy and signal belong to each invocation.
export type ModelContext = {
  system?: string;
  messages: Message[];
  tools?: ToolSpec[];
  webSearch?: boolean;
  imageInput?: boolean;
  parallelToolCalls?: boolean;
  // Per-request completion ceiling after the caller accounts for the prompt.
  // Providers decide whether and how their wire protocol can express it.
  maxOutputTokens?: number;
  signal?: AbortSignal;
};
