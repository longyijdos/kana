import {
  Agent,
  type AgentConfig,
  type ContextCheckpoint,
  createModelCompactPolicy,
  type PromptToolSection,
} from "@/agent";
import type { BackgroundJobClient } from "@/jobs";
import {
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createJobKillTool,
  createJobListTool,
  createJobOutputTool,
  createListTool,
  createReadTool,
  createViewImageTool,
  createWriteTool,
  type Tool,
} from "@/tools";
import { createKanaToolResultArtifactPolicy, type KanaSessionArtifactStore } from "./artifacts";
import type { KanaAgentConfig, KanaProviderConfig } from "./config";
import type { KanaGoalSnapshot, KanaGoalUpdate } from "./conversation/goal-controller";
import type { WakeScheduler } from "./conversation/wake-scheduler";
import type { KanaLaunchMode } from "./launch-mode";
import { createKanaAgentModelRuntime } from "./model";
import { buildKanaPromptAssembly } from "./prompt";
import { loadKanaSkills } from "./skills/loader";
import type { KanaTodoItem, KanaTodoStateChange } from "./todo";
import {
  createRememberTool,
  createScheduleWakeTool,
  createTodoWriteTool,
  createUpdateGoalTool,
} from "./tools";

// Reserve the complete built-in namespace, including tools that are enabled
// only for particular configurations or session states. MCP discovery happens
// before those states can change, so reserving only the first Agent's tools
// could let a later session recreation introduce a collision.
export const KANA_BUILT_IN_TOOL_NAMES = [
  "list",
  "glob",
  "grep",
  "read",
  "view_image",
  "write",
  "edit",
  "bash",
  "job_list",
  "job_output",
  "job_kill",
  "todo_write",
  "update_goal",
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
  resolveAdditionalTools?: () => Promise<readonly Tool[]> | readonly Tool[];
  env?: NodeJS.ProcessEnv;
  launchMode?: KanaLaunchMode;
  wakeScheduler?: WakeScheduler;
  sessionId?: string;
  contextCheckpoint?: ContextCheckpoint;
  artifactStore?: KanaSessionArtifactStore;
  backgroundJobs?: BackgroundJobClient;
  commitTodoState?: (change: KanaTodoStateChange) => Promise<void> | void;
  resolveTodoState?: () => readonly KanaTodoItem[];
  resolveGoal?: () => KanaGoalSnapshot | undefined;
  updateGoal?: (change: KanaGoalUpdate) => KanaGoalSnapshot;
};

export type KanaAgentDependencies = {
  providers: KanaProviderConfig;
  memoryEnabled: boolean;
};

export function createKanaAgent(
  config: KanaAgentConfig,
  dependencies: KanaAgentDependencies,
  options: KanaAgentOptions = {},
): Agent {
  const cwd = process.cwd();
  const backgroundJobs = options.backgroundJobs;
  const customizationsEnabled = options.launchMode !== "clean";
  const skills = customizationsEnabled ? loadKanaSkills({ cwd, env: options.env }).skills : [];
  const runtime = createKanaAgentModelRuntime(config, dependencies.providers, {
    env: options.env,
    logger: options.logger,
  });
  const { model } = runtime;
  const workspaceTools: Tool[] = [
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
    ...(runtime.imageInput
      ? [
          createViewImageTool({
            root: cwd,
          }),
        ]
      : []),
    createWriteTool({
      root: cwd,
    }),
    createEditTool({
      root: cwd,
    }),
    createBashTool({
      root: cwd,
      backgroundJobs,
    }),
  ];
  const toolSections: PromptToolSection[] = [{ name: "workspace", tools: workspaceTools }];
  if (backgroundJobs) {
    toolSections.push({
      name: "background-jobs",
      tools: [
        createJobListTool(backgroundJobs),
        createJobOutputTool(backgroundJobs),
        createJobKillTool(backgroundJobs),
      ],
    });
  }
  toolSections.push({
    name: "collaboration",
    tools: [
      createTodoWriteTool({
        commit: options.commitTodoState,
      }),
    ],
  });
  const resolveGoal = options.resolveGoal;
  const updateGoal = options.updateGoal;
  if (resolveGoal && updateGoal) {
    const resolveGoalTools = (): Tool[] =>
      resolveGoal()?.status !== "active"
        ? []
        : [
            createUpdateGoalTool({
              update: updateGoal,
            }),
          ];
    toolSections.push({
      name: "goal",
      tools: resolveGoalTools(),
      resolve: resolveGoalTools,
    });
  }
  if (customizationsEnabled && dependencies.memoryEnabled) {
    toolSections.push({
      name: "memory",
      tools: [
        createRememberTool({
          cwd,
          env: options.env,
        }),
      ],
    });
  }
  if (options.wakeScheduler && options.sessionId) {
    toolSections.push({
      name: "scheduled-wake",
      tools: [
        createScheduleWakeTool({
          scheduler: options.wakeScheduler,
          sessionId: options.sessionId,
        }),
      ],
    });
  }
  if (customizationsEnabled) {
    toolSections.push({
      name: "external",
      tools: options.additionalTools ?? [],
      resolve: options.resolveAdditionalTools,
    });
  }
  assertUniqueToolNames(toolSections.flatMap((section) => section.tools));

  return new Agent({
    model,
    promptAssembly: buildKanaPromptAssembly({
      cwd,
      env: options.env,
      launchMode: options.launchMode,
      memoryEnabled: dependencies.memoryEnabled,
      skills,
      resolveBackgroundJobState: backgroundJobs ? () => backgroundJobs.context() : undefined,
      toolSections,
      resolveTodoState: options.resolveTodoState,
      resolveGoalState: resolveGoal,
    }),
    maxTurns: config.maxTurns,
    toolDeadlineMs: config.toolDeadlineMs,
    webSearch: runtime.webSearch,
    imageInput: runtime.imageInput,
    parallelToolCalls: runtime.parallelToolCalls,
    maxParallelToolCalls: config.maxParallelToolCalls,
    repeatedToolCalls: config.repeatedToolCalls,
    toolResultPolicy: createKanaToolResultArtifactPolicy({
      ...(config.toolResultArtifacts && options.artifactStore
        ? { store: options.artifactStore }
        : {}),
      logger: options.logger,
    }),
    beforeToolExecution: options.beforeToolExecution,
    inbox: options.inbox,
    messages: options.messages,
    onRunCommitted: options.onRunCommitted,
    onCompactionCommitted: options.onCompactionCommitted,
    journal: options.journal,
    logger: options.logger,
    loggerMetadata: { agentKind: "conversation" },
    context: {
      contextLimit: runtime.contextLimit,
      maxOutputTokens: runtime.maxOutputTokens,
      compactPolicy: createModelCompactPolicy(model, {
        imageInputEnabled: runtime.imageInput,
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
