import {
  addModelUsage,
  calculateUsageCostCny,
  type Message,
  type ModelMetadata,
  type ModelUsage,
} from "@/core";
import { appendKanaRunAccounting } from "./storage";

export function recordKanaAgentRunAccounting(options: {
  sessionId: string;
  cwd: string;
  agentKind: "main" | "memory_consolidation";
  outcome: "stop" | "length" | "aborted" | "error" | "updated" | "unchanged";
  messages: Message[];
  model: ModelMetadata;
  memory?: {
    scope: "global" | "project";
    mode: "incremental" | "full";
    origin: "automatic" | "manual";
  };
}): void {
  const usage = options.messages.reduce<ModelUsage | undefined>(
    (total, message) =>
      message.role === "assistant" && message.usage ? addModelUsage(total, message.usage) : total,
    undefined,
  );
  appendKanaRunAccounting(
    {
      sessionId: options.sessionId,
      agentKind: options.agentKind,
      outcome: options.outcome,
      model: { provider: options.model.provider, model: options.model.model },
      pricing: options.model.cost,
      usage,
      costCny: usage ? calculateUsageCostCny(usage, options.model.cost) : 0,
      assistantMessageCount: options.messages.filter((message) => message.role === "assistant")
        .length,
      ...(options.memory
        ? {
            memoryScope: options.memory.scope,
            memoryMode: options.memory.mode,
            memoryOrigin: options.memory.origin,
          }
        : {}),
    },
    { cwd: options.cwd },
  );
}
