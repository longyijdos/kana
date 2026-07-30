import { Agent, type AgentConfig, type ContextCheckpoint, createModelCompactPolicy } from "@/agent";
import {
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createListTool,
  createReadTool,
  createRememberTool,
  createScheduleWakeTool,
  createWriteTool,
  type Tool,
} from "@/tools";
import { getActiveKanaModelConfig, type KanaConfig } from "./config";
import { createKanaModel } from "./model";
import { buildKanaSystemPrompt } from "./prompt";
import { loadKanaSkills } from "./skills";
import type { WakeScheduler } from "./wake-scheduler";

// Reserve the complete built-in namespace, including tools that are enabled
// only for particular configurations or session states. MCP discovery happens
// before those states can change, so reserving only the first Agent's tools
// could let a later session recreation introduce a collision.
export const KANA_BUILT_IN_TOOL_NAMES = [
  "list",
  "glob",
  "grep",
  "read",
  "write",
  "edit",
  "bash",
  "remember",
  "schedule_wake",
] as const;

export type KanaAgentOptions = Pick<
  AgentConfig,
  | "beforeToolExecution"
  | "messages"
  | "onRunCommitted"
  | "onCompactionCommitted"
  | "journal"
  | "logger"
> & {
  additionalTools?: readonly Tool[];
  wakeScheduler?: WakeScheduler;
  sessionId?: string;
  contextCheckpoint?: ContextCheckpoint;
};

export function createKanaAgent(config: KanaConfig, options: KanaAgentOptions = {}): Agent {
  const cwd = process.cwd();
  const { skills } = loadKanaSkills({ cwd });
  const model = createKanaModel(config, options.logger);
  const modelConfig = getActiveKanaModelConfig(config);
  const contextLimit = config.agent.contextLimit ?? model.metadata.contextWindow;
  if (contextLimit > model.metadata.contextWindow) {
    throw new Error(
      `agent.context_limit cannot exceed the ${model.metadata.contextWindow}-token context window for ${model.metadata.provider}/${model.metadata.model}.`,
    );
  }
  if (contextLimit <= modelConfig.maxTokens) {
    throw new Error("agent.context_limit must be greater than model.max_tokens.");
  }
  const tools: Tool[] = [
    createListTool({
      root: cwd,
    }),
    createGlobTool({
      root: cwd,
    }),
    createGrepTool({
      root: cwd,
    }),
    createReadTool({
      root: cwd,
    }),
    createWriteTool({
      root: cwd,
    }),
    createEditTool({
      root: cwd,
    }),
    createBashTool({
      root: cwd,
    }),
    ...(config.memory.enabled
      ? [
          createRememberTool({
            cwd,
          }),
        ]
      : []),
    ...(options.wakeScheduler && options.sessionId
      ? [
          createScheduleWakeTool({
            scheduler: options.wakeScheduler,
            sessionId: options.sessionId,
          }),
        ]
      : []),
    ...(options.additionalTools ?? []),
  ];
  assertUniqueToolNames(tools);

  return new Agent({
    model,
    system: buildKanaSystemPrompt({ cwd, skills }),
    tools,
    maxTurns: config.agent.maxTurns,
    beforeToolExecution: options.beforeToolExecution,
    messages: options.messages,
    onRunCommitted: options.onRunCommitted,
    onCompactionCommitted: options.onCompactionCommitted,
    journal: options.journal,
    logger: options.logger,
    loggerMetadata: { agentKind: "conversation" },
    context: {
      contextLimit,
      outputReserve: modelConfig.maxTokens,
      compactPolicy: createModelCompactPolicy(model),
      checkpoint: options.contextCheckpoint,
    },
  });
}

function assertUniqueToolNames(tools: readonly Tool[]): void {
  const names = new Set<string>();

  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate Kana Agent tool name: ${tool.name}.`);
    }
    names.add(tool.name);
  }
}
