import { Agent, type AgentState } from "@/agent";
import type { KanaConfig } from "../config";
import { type KanaMemoryEntry, type KanaMemoryScope, loadKanaMemory } from "../memory";
import { createKanaModel } from "../model";
import { buildMemoryConsolidationPrompt } from "./consolidation-prompt";
import {
  createMemoryConsolidationTools,
  type MemoryConsolidationMode,
} from "./consolidation-tools";

export type CreateMemoryConsolidationAgentOptions = {
  scope: KanaMemoryScope;
  mode: MemoryConsolidationMode;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export function createMemoryConsolidationAgent(
  config: KanaConfig,
  options: CreateMemoryConsolidationAgentOptions,
): Agent {
  if (!config.memory.enabled) {
    throw new Error("Memory is disabled.");
  }

  return new Agent({
    model: createKanaModel(config),
    system: buildMemoryConsolidationPrompt(options.scope, options.mode),
    tools: createMemoryConsolidationTools(options, options.mode),
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
  const agent = createMemoryConsolidationAgent(config, options);
  await agent.prompt(options.input);
  return agent.state;
}
