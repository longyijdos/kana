import { DEFAULT_MAX_PARALLEL_TOOL_CALLS } from "@/agent";
import type { KanaConfig } from "./contracts";

// Keep the outer tool deadline above bash's ten-minute command ceiling so
// bash can terminate the process tree and report its own timeout result.
const DEFAULT_KANA_AGENT_TOOL_DEADLINE_MS = 11 * 60 * 1000;

export const DEFAULT_KANA_CONFIG: KanaConfig = {
  provider: {
    deepseek: {
      apiKeyEnv: "DEEPSEEK_API_KEY",
      timeoutMs: 60_000,
      maxRetries: 1,
    },
    "openai-codex": {
      reasoningSummary: "auto",
      timeoutMs: 60_000,
      maxRetries: 1,
    },
  },
  agent: {
    webSearch: true,
    imageInput: true,
    maxTurns: -1,
    goalMaxRounds: 8,
    toolDeadlineMs: DEFAULT_KANA_AGENT_TOOL_DEADLINE_MS,
    parallelToolCalls: true,
    maxParallelToolCalls: DEFAULT_MAX_PARALLEL_TOOL_CALLS,
    model: {
      provider: "deepseek",
      name: "deepseek-v4-pro",
      reasoningEffort: undefined,
      maxOutputTokens: undefined,
      contextLimit: undefined,
    },
    toolResultArtifacts: true,
    backgroundJobs: {
      maxConcurrent: 4,
    },
    repeatedToolCalls: {
      reminderThresholds: [3, 5, 8],
      excludedTools: [],
    },
  },
  approval: {
    mode: "unless_trusted",
  },
  notification: {
    backend: "auto",
    onAgentCompleted: true,
    onApprovalRequired: true,
  },
  tui: {
    theme: "kana",
    hyperlinks: true,
    renderLatex: true,
    renderMermaid: true,
    smoothTextStreaming: true,
    collapseLongPastes: true,
  },
  memory: {
    enabled: true,
    maxChars: 6000,
    dailyRetentionDays: undefined,
    agent: {
      webSearch: false,
      imageInput: false,
      maxTurns: -1,
      toolDeadlineMs: DEFAULT_KANA_AGENT_TOOL_DEADLINE_MS,
      parallelToolCalls: true,
      maxParallelToolCalls: DEFAULT_MAX_PARALLEL_TOOL_CALLS,
      model: {
        provider: "deepseek",
        name: "deepseek-v4-flash",
        reasoningEffort: undefined,
        maxOutputTokens: undefined,
        contextLimit: undefined,
      },
    },
  },
  logging: {
    level: "info",
  },
};
