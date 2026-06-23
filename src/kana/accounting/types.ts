import type { ModelCost, ModelUsage } from "@/core";

export const KANA_ACCOUNTING_VERSION = 1;

export type KanaAccountingAgentKind = "main" | "memory_consolidation";
export type KanaAccountingOutcome =
  | "stop"
  | "length"
  | "aborted"
  | "error"
  | "updated"
  | "unchanged";

export type KanaRunAccountingRecord = {
  type: "run";
  version: typeof KANA_ACCOUNTING_VERSION;
  id: string;
  recordedAt: string;
  sessionId: string;
  agentKind: KanaAccountingAgentKind;
  outcome: KanaAccountingOutcome;
  model: { provider: string; model: string };
  pricing: ModelCost;
  usage?: ModelUsage;
  costCny: number;
  assistantMessageCount: number;
  memoryScope?: "global" | "project";
  memoryMode?: "incremental" | "full";
  memoryOrigin?: "automatic" | "manual";
};

export type AppendKanaRunAccountingOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type KanaUsageScope = "session" | "project" | "global";

export type LoadKanaUsageSummaryOptions = AppendKanaRunAccountingOptions & {
  scope: KanaUsageScope;
  sessionId?: string;
};

export type KanaUsageSummary = {
  scope: KanaUsageScope;
  runCount: number;
  mainRunCount: number;
  memoryRunCount: number;
  costCny: number;
  usage?: ModelUsage;
  outcomes: Record<KanaAccountingOutcome, number>;
  agents: Record<
    "main" | "memoryAutomatic" | "memoryManual",
    { runCount: number; costCny: number; usage?: ModelUsage }
  >;
  models: Array<{
    provider: string;
    model: string;
    runCount: number;
    costCny: number;
    usage?: ModelUsage;
  }>;
};
