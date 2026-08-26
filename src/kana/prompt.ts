import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  createPromptAssembly,
  type PromptAssembly,
  type PromptContextSection,
  type PromptContextState,
  type PromptSystemSection,
  type PromptToolSection,
} from "@/agent";
import type { BackgroundJobSummary } from "@/jobs";
import { loadKanaConfig } from "./config";
import {
  type CollectKanaEnvironmentContextOptions,
  collectKanaEnvironmentContext,
  formatKanaEnvironmentContext,
} from "./context";
import type { KanaGoalSnapshot } from "./conversation/goal-controller";
import type { KanaLaunchMode } from "./launch-mode";
import { formatKanaMemoryForPrompt } from "./memory/prompt";
import { getKanaConfigPaths } from "./path";
import { formatKanaSkillsForPrompt } from "./skills/prompt";
import type { KanaSkill } from "./skills/types";
import type { KanaTodoItem } from "./todo";

const DEFAULT_SYSTEM_PROMPT =
  "You are a concise, practical assistant working in the user's current environment.";

type LoadKanaSystemPromptOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  launchMode?: KanaLaunchMode;
};

export type BuildKanaSystemPromptOptions = CollectKanaEnvironmentContextOptions & {
  env?: NodeJS.ProcessEnv;
  launchMode?: KanaLaunchMode;
  memoryEnabled?: boolean;
  skills?: KanaSkill[];
};

export type BuildKanaPromptAssemblyOptions = BuildKanaSystemPromptOptions & {
  resolveBackgroundJobState?: () => readonly BackgroundJobSummary[];
  toolSections?: readonly PromptToolSection[];
  resolveTodoState?: () => readonly KanaTodoItem[];
  resolveGoalState?: () => KanaGoalSnapshot | undefined;
};

function loadKanaSystemSections(options: LoadKanaSystemPromptOptions = {}): PromptSystemSection[] {
  const cwd = options.cwd ?? process.cwd();
  const customizationsEnabled = options.launchMode !== "clean";
  const { agentsPath } = getKanaConfigPaths(options.env);
  const projectAgentsPath = path.join(cwd, "AGENTS.md");
  const sections: PromptSystemSection[] = [{ name: "assistant", content: DEFAULT_SYSTEM_PROMPT }];

  if (customizationsEnabled && existsSync(agentsPath)) {
    sections.push({
      name: "agents:global",
      content: formatAgentsInstructions("global", readFileSync(agentsPath, "utf8")),
    });
  }

  // AGENTS.md files refine the built-in operating rules. Project instructions
  // are appended after global instructions so local repository conventions have
  // the more specific, later position.
  if (customizationsEnabled && path.resolve(projectAgentsPath) !== path.resolve(agentsPath)) {
    if (existsSync(projectAgentsPath)) {
      sections.push({
        name: "agents:project",
        content: formatAgentsInstructions("project", readFileSync(projectAgentsPath, "utf8")),
      });
    }
  }

  return sections;
}

export function buildKanaSystemPrompt(options: BuildKanaSystemPromptOptions = {}): string {
  return buildKanaPromptAssembly(options).initialSystem ?? "";
}

export function buildKanaPromptAssembly(
  options: BuildKanaPromptAssemblyOptions = {},
): PromptAssembly {
  const customizationsEnabled = options.launchMode !== "clean";
  const memoryEnabled =
    customizationsEnabled && (options.memoryEnabled ?? loadKanaConfig(options.env).memory.enabled);
  const memoryPrompt = memoryEnabled ? formatKanaMemoryForPrompt(options) : undefined;
  const instructionSections = loadKanaSystemSections({
    cwd: options.cwd,
    env: options.env,
    launchMode: options.launchMode,
  });
  const skillsPrompt = customizationsEnabled
    ? formatKanaSkillsForPrompt(options.skills ?? [], { env: options.env })
    : "";
  const resolveBackgroundJobState = options.resolveBackgroundJobState;
  const contextSections: PromptContextSection[] = [
    {
      name: "environment",
      render: () => ({
        status: "active",
        content: formatKanaEnvironmentContext(collectKanaEnvironmentContext(options)),
      }),
    },
    ...(resolveBackgroundJobState
      ? [
          {
            name: "background-jobs",
            render: () => formatBackgroundJobContext(resolveBackgroundJobState()),
          },
        ]
      : []),
    ...(options.resolveTodoState
      ? [
          {
            name: "todo",
            render: () => formatKanaTodoRuntimeContext(options.resolveTodoState?.() ?? []),
          },
        ]
      : []),
    ...(options.resolveGoalState
      ? [
          {
            name: "goal",
            render: () => formatKanaGoalRuntimeContext(options.resolveGoalState?.()),
          },
        ]
      : []),
  ];

  return createPromptAssembly({
    system: [
      ...(memoryPrompt ? [{ name: "memory", content: memoryPrompt }] : []),
      ...instructionSections,
      ...(skillsPrompt ? [{ name: "skills", content: skillsPrompt }] : []),
    ],
    context: contextSections,
    tools: options.toolSections,
  });
}

function formatBackgroundJobContext(visible: readonly BackgroundJobSummary[]): PromptContextState {
  if (visible.length === 0) {
    return {
      status: "inactive",
      content: JSON.stringify({ jobs: [] }),
    };
  }
  return {
    status: "active",
    content: JSON.stringify({
      jobs: visible.map((job) => ({
        id: job.id,
        kind: job.kind,
        label: job.label,
        cwd: job.cwd,
        status: job.status,
        exitCode: job.exitCode,
      })),
    }),
  };
}

function formatKanaGoalRuntimeContext(goal: KanaGoalSnapshot | undefined): PromptContextState {
  if (goal?.status !== "active") {
    return {
      status: "inactive",
      content: JSON.stringify({ authorized: false }),
    };
  }

  return {
    status: "active",
    content: JSON.stringify({ authorized: true, objective: goal.objective }),
  };
}

function formatKanaTodoRuntimeContext(items: readonly KanaTodoItem[]): PromptContextState {
  if (items.length === 0) {
    return {
      status: "inactive",
      content: JSON.stringify({ items: [] }),
    };
  }

  return {
    status: "active",
    content: JSON.stringify({ items }),
  };
}

function formatAgentsInstructions(scope: "global" | "project", content: string): string {
  return [
    `<agents_instructions scope="${scope}">`,
    content.trimEnd(),
    "</agents_instructions>",
  ].join("\n");
}
