import { Agent, type AgentState } from "@/agent";
import type { KanaConfig } from "../config";
import { createKanaModel } from "../model";
import { buildMemoryConsolidationPrompt } from "./consolidation-prompt";
import {
  createMemoryConsolidationTools,
  createMemoryConsolidationTransaction,
  type MemoryConsolidationMode,
  type MemoryConsolidationTransaction,
} from "./consolidation-tools";
import { type KanaMemoryEntry, type KanaMemoryScope, loadKanaMemory } from "./storage";

export type CreateMemoryConsolidationAgentOptions = {
  scope: KanaMemoryScope;
  mode: MemoryConsolidationMode;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export function createMemoryConsolidationAgent(
  config: KanaConfig,
  options: CreateMemoryConsolidationAgentOptions,
  memory: MemoryConsolidationTransaction = createMemoryConsolidationTransaction(options),
): Agent {
  if (!config.memory.enabled) {
    throw new Error("Memory is disabled.");
  }

  return new Agent({
    model: createKanaModel(config),
    system: buildMemoryConsolidationPrompt(options.scope, options.mode),
    tools: createMemoryConsolidationTools(options, options.mode, memory),
    maxTurns: config.agent.maxTurns,
  });
}

export function formatIncrementalMemoryConsolidationInput(
  scope: KanaMemoryScope,
  entries: KanaMemoryEntry[],
  options: Pick<CreateMemoryConsolidationAgentOptions, "cwd" | "env"> = {},
): string {
  return [
    `<current_memory scope="${scope}">`,
    loadKanaMemory(scope, options).trim(),
    "</current_memory>",
    "<new_daily_entries>",
    JSON.stringify(entries),
    "</new_daily_entries>",
  ].join("\n");
}

export async function runMemoryConsolidation(
  config: KanaConfig,
  options: CreateMemoryConsolidationAgentOptions & { input: string },
): Promise<AgentState> {
  const memory = createMemoryConsolidationTransaction(options);
  const agent = createMemoryConsolidationAgent(config, options, memory);
  await agent.prompt(options.input);

  const finalMessage = agent.state.messages.at(-1);
  if (finalMessage?.role === "assistant" && finalMessage.stopReason === "stop") {
    memory.commit();
  }

  return agent.state;
}
