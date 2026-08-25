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
import { getKanaConfigPaths, loadKanaConfig } from "./config";
import {
  type CollectKanaEnvironmentContextOptions,
  collectKanaEnvironmentContext,
  formatKanaEnvironmentContext,
} from "./context";
import type { KanaGoalSnapshot } from "./conversation/goal-controller";
import type { KanaLaunchMode } from "./launch-mode";
import { formatKanaMemoryForPrompt } from "./memory/prompt";
import { formatKanaSkillsForPrompt } from "./skills/prompt";
import type { KanaSkill } from "./skills/types";
import type { KanaTodoItem } from "./todo";

const DEFAULT_SYSTEM_PROMPT = [
  "You are a concise, practical assistant working in the user's current environment.",
  "Use list and glob for file discovery, grep for content search, and read for file contents.",
  "Use write to create complete files, and set overwrite only when intentionally replacing the whole file.",
  "Use edit to modify existing files by exact text replacement.",
  "Use bash when a shell command is the right way to inspect or change local state.",
  "Use todo_write to keep a whole-list plan synchronized during multi-step work, but skip it for simple tasks.",
  "Do not claim to have read a file unless you used the read tool or the content was provided directly.",
].join(" ");

type LoadKanaSystemPromptOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  launchMode?: KanaLaunchMode;
};

export type BuildKanaSystemPromptOptions = CollectKanaEnvironmentContextOptions & {
  env?: NodeJS.ProcessEnv;
  launchMode?: KanaLaunchMode;
  skills?: KanaSkill[];
};

export type BuildKanaPromptAssemblyOptions = BuildKanaSystemPromptOptions & {
  capabilitySystemSections?: readonly PromptSystemSection[];
  capabilityContextSections?: readonly PromptContextSection[];
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
  const memoryEnabled = customizationsEnabled && loadKanaConfig(options.env).memory.enabled;
  const memoryPrompt = memoryEnabled ? formatKanaMemoryForPrompt(options) : undefined;
  const instructionSections = loadKanaSystemSections({
    cwd: options.cwd,
    env: options.env,
    launchMode: options.launchMode,
  });
  const skillsPrompt = customizationsEnabled
    ? formatKanaSkillsForPrompt(options.skills ?? [], { env: options.env })
    : "";

  return createPromptAssembly({
    system: [
      ...(memoryPrompt ? [{ name: "memory", content: memoryPrompt }] : []),
      ...instructionSections,
      ...(options.capabilitySystemSections ?? []),
      ...(skillsPrompt ? [{ name: "skills", content: skillsPrompt }] : []),
    ],
    context: [
      {
        name: "environment",
        render: () => ({
          status: "active",
          content: formatKanaEnvironmentContext(collectKanaEnvironmentContext(options)),
        }),
      },
      ...(options.capabilityContextSections ?? []),
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
    ],
    tools: options.toolSections,
  });
}

function formatKanaGoalRuntimeContext(goal: KanaGoalSnapshot | undefined): PromptContextState {
  if (goal?.status !== "active") {
    return {
      status: "inactive",
      content:
        "No user-authorized goal is currently active. Do not continue an earlier goal automatically.",
    };
  }

  return {
    status: "active",
    content: [
      "An explicitly user-authorized goal is active for this process.",
      "Continue making concrete progress toward the objective.",
      "Call update_goal with completed only when the objective is achieved, or blocked only when meaningful progress requires user input or an external state change.",
      JSON.stringify({
        goal: {
          objective: goal.objective,
        },
      }),
    ].join("\n"),
  };
}

function formatKanaTodoRuntimeContext(items: readonly KanaTodoItem[]): PromptContextState {
  if (items.length === 0) {
    return {
      status: "inactive",
      content: "The current session todo list is empty.",
    };
  }

  return {
    status: "active",
    content: [
      "Current session todo state. todo_write replaces the complete list when updating it.",
      JSON.stringify({ items }),
    ].join("\n"),
  };
}

function formatAgentsInstructions(scope: "global" | "project", content: string): string {
  return [
    `<agents_instructions scope="${scope}">`,
    content.trimEnd(),
    "</agents_instructions>",
  ].join("\n");
}
