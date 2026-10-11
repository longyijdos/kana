import type { Model } from "@/core";

const DEFAULT_MAX_TURNS = 8;
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 4;
export const DEFAULT_TOOL_DEADLINE_MS = 300_000;

// Run settings after applying defaults and the selected model's capabilities.
// Model requests and tool scheduling read these values instead of re-deriving
// them, so what the provider is told always matches what the runtime does.
export type AgentSettings = {
  readonly model: Model;
  // -1 removes the turn limit.
  readonly maxTurns: number;
  readonly toolDeadlineMs: number;
  readonly webSearch: boolean;
  readonly imageInput: boolean;
  readonly parallelToolCalls: boolean;
  readonly maxParallelToolCalls: number;
};

export type AgentSettingsOptions = {
  model: Model;
  maxTurns?: number;
  toolDeadlineMs?: number;
  webSearch?: boolean;
  imageInput?: boolean;
  parallelToolCalls?: boolean;
  maxParallelToolCalls?: number;
};

export function resolveAgentSettings(options: AgentSettingsOptions): AgentSettings {
  const { metadata } = options.model;
  return {
    model: options.model,
    maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
    toolDeadlineMs: options.toolDeadlineMs ?? DEFAULT_TOOL_DEADLINE_MS,
    webSearch: (options.webSearch ?? true) && metadata.supportsHostedWebSearch,
    imageInput: (options.imageInput ?? true) && metadata.supportsImageInput === true,
    parallelToolCalls: (options.parallelToolCalls ?? true) && metadata.supportsParallelToolCalls,
    maxParallelToolCalls: options.maxParallelToolCalls ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS,
  };
}
