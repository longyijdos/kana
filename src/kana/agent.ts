import {
  Agent,
  type AgentConfig,
  type ContextCheckpoint,
  createModelCompactPolicy,
  createPromptAssembly,
  type PromptSystemSection,
  type PromptToolSection,
} from "@/agent";
import type { BackgroundJobClient } from "@/jobs";
import type { McpToolRegistry } from "@/mcp";
import {
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createJobKillTool,
  createJobListTool,
  createJobOutputTool,
  createJobStartTool,
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
import type { KanaCustomProviderSnapshot } from "./custom-provider";
import type { KanaLaunchMode } from "./launch-mode";
import { createKanaAgentModelRuntime } from "./model";
import { buildKanaPromptAssembly } from "./prompt";
import { loadKanaSkillActivations } from "./skills/loader";
import type { KanaSkill } from "./skills/types";
import type {
  KanaSubagentClient,
  KanaSubagentProfile,
  KanaSubagentRunContext,
  KanaSubagentRunResult,
} from "./subagents";
import type { KanaTodoItem, KanaTodoStateChange } from "./todo";
import { KANA_WORKSPACE_TOOL_NAMES } from "./tool-names";
import {
  createCancelSubagentTool,
  createDelegateUserTaskTool,
  createMcpTools,
  createRememberTool,
  createScheduleWakeTool,
  createSpawnSubagentTool,
  createTodoWriteTool,
  createUpdateGoalTool,
  createWaitSubagentTool,
} from "./tools";
import type { KanaUserTaskManager } from "./user-tasks";

export { KANA_BUILT_IN_TOOL_NAMES } from "./tool-names";

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
  resolveMcp?: () => McpToolRegistry | undefined;
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
  subagentProfile?: KanaSubagentProfile;
  subagents?: KanaSubagentClient;
  userTasks?: KanaUserTaskManager;
  subagentProfiles?: readonly KanaSubagentProfile[];
  runSubagent?: (context: KanaSubagentRunContext) => Promise<KanaSubagentRunResult>;
  skills?: readonly KanaSkill[];
  customProviderSnapshot?: KanaCustomProviderSnapshot;
  instructionSections?: readonly PromptSystemSection[];
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
  const subagentProfile = options.subagentProfile;
  const subagents = options.subagents;
  const customizationsEnabled = options.launchMode !== "clean";
  const skills =
    customizationsEnabled && !subagentProfile
      ? (options.skills ??
        loadKanaSkillActivations({ cwd, env: options.env }).skills.filter((skill) => skill.enabled))
      : [];
  const runtime = createKanaAgentModelRuntime(config, dependencies.providers, {
    env: options.env,
    logger: options.logger,
    customProviderSnapshot: options.customProviderSnapshot,
  });
  const { model } = runtime;
  const enabledTools = new Set<string>(config.tools);
  const subagentImageInput = new Map<string, boolean>();
  const selectEnabledTools = (tools: Tool[]): Tool[] =>
    tools.filter(
      (tool) =>
        enabledTools.has(tool.name) &&
        (subagentProfile === undefined || subagentProfile.tools.includes(tool.name)),
    );
  const resolveMcpTools = (): Tool[] => {
    const registry = customizationsEnabled ? options.resolveMcp?.() : undefined;
    return registry?.catalog.length ? selectEnabledTools(createMcpTools(registry)) : [];
  };
  const workspaceTools: Tool[] = selectEnabledTools([
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
    }),
  ]);
  const subagentProfiles = options.subagentProfiles ?? [];
  const toolSections: PromptToolSection[] = [{ name: "workspace", tools: workspaceTools }];
  if (backgroundJobs && !subagentProfile) {
    toolSections.push({
      name: "background-jobs",
      tools: selectEnabledTools([
        createJobStartTool(backgroundJobs, { root: cwd }),
        createJobListTool(backgroundJobs),
        createJobOutputTool(backgroundJobs),
        createJobKillTool(backgroundJobs),
      ]),
    });
  }
  if (!subagentProfile && subagents && subagentProfiles.length > 0 && options.runSubagent) {
    const resolveSubagentImageInput = (profile: KanaSubagentProfile): boolean => {
      if (!profile.model) return runtime.imageInput;
      const cached = subagentImageInput.get(profile.digest);
      if (cached !== undefined) return cached;
      let supported = false;
      try {
        supported = createKanaAgentModelRuntime(
          {
            ...config,
            model: {
              provider: profile.model.provider,
              name: profile.model.name,
              reasoningEffort: profile.model.reasoningEffort,
            },
          },
          dependencies.providers,
          {
            env: options.env,
            logger: options.logger,
            customProviderSnapshot: options.customProviderSnapshot,
          },
        ).imageInput;
      } catch {
        supported = false;
      }
      subagentImageInput.set(profile.digest, supported);
      return supported;
    };
    const availableTools = (profile: KanaSubagentProfile): string[] => [
      ...KANA_WORKSPACE_TOOL_NAMES.filter(
        (name) =>
          enabledTools.has(name) &&
          profile.tools.includes(name) &&
          (name !== "view_image" || resolveSubagentImageInput(profile)),
      ),
      ...resolveMcpTools()
        .filter((tool) => profile.tools.includes(tool.name))
        .map((tool) => tool.name),
    ];
    const createSubagentTools = (): Tool[] =>
      selectEnabledTools([
        createSpawnSubagentTool({
          subagents,
          profiles: subagentProfiles,
          availableTools,
          run: options.runSubagent as (
            context: KanaSubagentRunContext,
          ) => Promise<KanaSubagentRunResult>,
        }),
        createWaitSubagentTool(subagents),
        createCancelSubagentTool(subagents),
      ]);
    toolSections.push({
      name: "subagents",
      tools: createSubagentTools(),
      resolve: createSubagentTools,
    });
  }
  if (!subagentProfile) {
    toolSections.push({
      name: "collaboration",
      tools: selectEnabledTools([
        createTodoWriteTool({
          commit: options.commitTodoState,
        }),
        ...(options.userTasks ? [createDelegateUserTaskTool(options.userTasks)] : []),
      ]),
    });
  }
  const resolveGoal = options.resolveGoal;
  const updateGoal = options.updateGoal;
  if (!subagentProfile && resolveGoal && updateGoal) {
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
  if (!subagentProfile && customizationsEnabled && dependencies.memoryEnabled) {
    toolSections.push({
      name: "memory",
      tools: selectEnabledTools([
        createRememberTool({
          cwd,
          env: options.env,
        }),
      ]),
    });
  }
  if (!subagentProfile && options.wakeScheduler && options.sessionId) {
    toolSections.push({
      name: "scheduled-wake",
      tools: selectEnabledTools([
        createScheduleWakeTool({
          scheduler: options.wakeScheduler,
          sessionId: options.sessionId,
        }),
      ]),
    });
  }
  if (customizationsEnabled && options.resolveMcp) {
    toolSections.push({
      name: "mcp",
      tools: resolveMcpTools(),
      resolve: resolveMcpTools,
    });
  }
  const promptAssembly = subagentProfile
    ? createPromptAssembly({
        system: [
          {
            name: `subagent:${subagentProfile.name}`,
            content: subagentProfile.instructions,
          },
        ],
        tools: toolSections,
      })
    : buildKanaPromptAssembly({
        cwd,
        env: options.env,
        launchMode: options.launchMode,
        memoryEnabled: dependencies.memoryEnabled,
        skills,
        instructionSections: options.instructionSections,
        resolveBackgroundJobState: backgroundJobs ? () => backgroundJobs.context() : undefined,
        toolSections,
        resolveTodoState: options.resolveTodoState,
        resolveUserTaskState: options.userTasks
          ? () => options.userTasks?.context() ?? []
          : undefined,
        resolveGoalState: resolveGoal,
        resolveSubagentState: subagents ? () => subagents.context() : undefined,
      });

  return new Agent({
    model,
    promptAssembly,
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
    messages: subagentProfile ? undefined : options.messages,
    onRunCommitted: options.onRunCommitted,
    onCompactionCommitted: options.onCompactionCommitted,
    journal: options.journal,
    logger: options.logger,
    loggerMetadata: { agentKind: subagentProfile ? "subagent" : "conversation" },
    context: {
      contextLimit: runtime.contextLimit,
      maxOutputTokens: runtime.maxOutputTokens,
      compactPolicy: createModelCompactPolicy(model, {
        imageInputEnabled: runtime.imageInput,
      }),
      checkpoint: subagentProfile ? undefined : options.contextCheckpoint,
    },
  });
}
