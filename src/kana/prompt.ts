import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { getKanaConfigPaths, loadKanaConfig } from "./config";
import {
  type CollectKanaEnvironmentContextOptions,
  collectKanaEnvironmentContext,
  formatKanaEnvironmentContext,
} from "./context";
import { escapeXml } from "./format";
import type { KanaLaunchMode } from "./launch-mode";
import { loadKanaMemory } from "./memory/storage";
import { formatKanaSkillsForPrompt } from "./skills/prompt";
import type { KanaSkill } from "./skills/types";

const DEFAULT_SYSTEM_PROMPT = [
  "You are a concise, practical assistant working in the user's current environment.",
  "Use list and glob for file discovery, grep for content search, and read for file contents.",
  "Use write to create complete files, and set overwrite only when intentionally replacing the whole file.",
  "Use edit to modify existing files by exact text replacement.",
  "Use bash when a shell command is the right way to inspect or change local state.",
  "Do not claim to have read a file unless you used the read tool or the content was provided directly.",
].join(" ");

const REMEMBER_TOOL_GUIDANCE = [
  "<remember_tool_guidance>",
  "Proactively use remember when the user explicitly shares non-sensitive information likely to help future conversations, including enduring preferences, working style, recurring constraints, relevant background, confirmed decisions, project milestones that affect the current state or next steps, and unfinished work.",
  "Record qualifying information even when a normal response fully handles the current turn.",
  "Default to project scope. Use global scope only for information that applies across projects.",
  "Do not record secrets, sensitive personal information, short-lived progress updates with no future impact, or facts that can be read directly from the workspace.",
  "</remember_tool_guidance>",
].join("\n");

export type LoadKanaSystemPromptOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  launchMode?: KanaLaunchMode;
};

export type BuildKanaSystemPromptOptions = CollectKanaEnvironmentContextOptions & {
  env?: NodeJS.ProcessEnv;
  launchMode?: KanaLaunchMode;
  skills?: KanaSkill[];
};

export function loadKanaSystemPrompt(options: LoadKanaSystemPromptOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const customizationsEnabled = options.launchMode !== "clean";
  const { agentsPath } = getKanaConfigPaths(options.env);
  const projectAgentsPath = path.join(cwd, "AGENTS.md");
  const instructionBlocks: string[] = [DEFAULT_SYSTEM_PROMPT];

  if (customizationsEnabled && existsSync(agentsPath)) {
    instructionBlocks.push(formatAgentsInstructions("global", readFileSync(agentsPath, "utf8")));
  }

  // AGENTS.md files refine the built-in operating rules. Project instructions
  // are appended after global instructions so local repository conventions have
  // the more specific, later position.
  if (customizationsEnabled && path.resolve(projectAgentsPath) !== path.resolve(agentsPath)) {
    if (existsSync(projectAgentsPath)) {
      instructionBlocks.push(
        formatAgentsInstructions("project", readFileSync(projectAgentsPath, "utf8")),
      );
    }
  }

  return instructionBlocks.join("\n\n");
}

export function buildKanaSystemPrompt(options: BuildKanaSystemPromptOptions = {}): string {
  const customizationsEnabled = options.launchMode !== "clean";
  const memoryEnabled = customizationsEnabled && loadKanaConfig(options.env).memory.enabled;
  const memoryPrompt = memoryEnabled ? formatKanaMemoryForPrompt(options) : undefined;
  const systemPrompt = loadKanaSystemPrompt({
    cwd: options.cwd,
    env: options.env,
    launchMode: options.launchMode,
  }).trimEnd();
  const environmentContext = formatKanaEnvironmentContext(collectKanaEnvironmentContext(options));
  const skillsPrompt = customizationsEnabled
    ? formatKanaSkillsForPrompt(options.skills ?? [], { env: options.env })
    : "";

  return [
    memoryPrompt,
    memoryEnabled ? REMEMBER_TOOL_GUIDANCE : undefined,
    systemPrompt,
    environmentContext,
    skillsPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatKanaMemoryForPrompt(options: BuildKanaSystemPromptOptions): string | undefined {
  const globalMemory = loadKanaMemory("global", options).trim();
  const projectMemory = loadKanaMemory("project", options).trim();
  const memoryBlocks = [
    globalMemory ? formatMemoryBlock("global", globalMemory) : undefined,
    projectMemory ? formatMemoryBlock("project", projectMemory) : undefined,
  ].filter((block): block is string => block !== undefined);

  if (memoryBlocks.length === 0) {
    return undefined;
  }

  return ["<memory>", ...memoryBlocks, "</memory>"].join("\n");
}

function formatAgentsInstructions(scope: "global" | "project", content: string): string {
  return [
    `<agents_instructions scope="${scope}">`,
    content.trimEnd(),
    "</agents_instructions>",
  ].join("\n");
}

function formatMemoryBlock(scope: "global" | "project", content: string): string {
  return [`<memory_reference scope="${scope}">`, escapeXml(content), "</memory_reference>"].join(
    "\n",
  );
}
