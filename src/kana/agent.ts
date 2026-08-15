import { Agent, type AgentConfig, type ContextCheckpoint, createModelCompactPolicy } from "@/agent";
import {
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createListTool,
  createReadTool,
  createWriteTool,
  type Tool,
} from "@/tools";
import { getActiveKanaModelConfig, type KanaConfig } from "./config";
import type { WakeScheduler } from "./conversation/wake-scheduler";
import type { KanaLaunchMode } from "./launch-mode";
import { createKanaModel } from "./model";
import { buildKanaSystemPrompt } from "./prompt";
import { loadKanaSkills } from "./skills/loader";
import { createRememberTool, createScheduleWakeTool } from "./tools";

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
  | "inbox"
  | "messages"
  | "onRunCommitted"
  | "onCompactionCommitted"
  | "journal"
  | "logger"
> & {
  additionalTools?: readonly Tool[];
  env?: NodeJS.ProcessEnv;
  launchMode?: KanaLaunchMode;
  wakeScheduler?: WakeScheduler;
  sessionId?: string;
  contextCheckpoint?: ContextCheckpoint;
};

export function createKanaAgent(config: KanaConfig, options: KanaAgentOptions = {}): Agent {
  const cwd = process.cwd();
  const customizationsEnabled = options.launchMode !== "clean";
  const skills = customizationsEnabled ? loadKanaSkills({ cwd, env: options.env }).skills : [];
  const model = createKanaModel(config, options.logger);
  const modelConfig = getActiveKanaModelConfig(config);
  const contextLimit = config.agent.contextLimit ?? model.metadata.contextWindow;
  if (contextLimit > model.metadata.contextWindow) {
    throw new Error(
      `agent.context_limit cannot exceed the ${model.metadata.contextWindow}-token context window for ${model.metadata.provider}/${model.metadata.model}.`,
    );
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
    ...(customizationsEnabled && config.memory.enabled
      ? [
          createRememberTool({
            cwd,
            env: options.env,
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
    ...(customizationsEnabled ? (options.additionalTools ?? []) : []),
  ];
  assertUniqueToolNames(tools);

  return new Agent({
    model,
    system: buildKanaSystemPrompt({
      cwd,
      env: options.env,
      launchMode: options.launchMode,
      skills,
    }),
    tools,
    maxTurns: config.agent.maxTurns,
    toolDeadlineMs: config.agent.toolDeadlineMs,
    parallelToolCalls: config.agent.parallelToolCalls,
    beforeToolExecution: options.beforeToolExecution,
    inbox: options.inbox,
    messages: options.messages,
    onRunCommitted: options.onRunCommitted,
    onCompactionCommitted: options.onCompactionCommitted,
    journal: options.journal,
    logger: options.logger,
    loggerMetadata: { agentKind: "conversation" },
    context: {
      contextLimit,
      maxOutputTokens: modelConfig.maxTokens,
      compactPolicy: createModelCompactPolicy(model, {
        // Capability and configuration are separate: a capable model must not
        // receive image bytes when the provider setting disables them.
        imageInputEnabled:
          model.metadata.supportsImageInput === true && modelConfig.imageInput !== false,
      }),
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
