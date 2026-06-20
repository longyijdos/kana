import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { getKanaConfigPaths, loadKanaConfig } from "./config";
import {
  type CollectKanaEnvironmentContextOptions,
  collectKanaEnvironmentContext,
  formatKanaEnvironmentContext,
} from "./context";
import { escapeXml } from "./format";
import { loadKanaMemory } from "./memory";
import { formatKanaSkillsForPrompt, type KanaSkill } from "./skills";

const DEFAULT_SYSTEM_PROMPT = [
  "You are a concise coding assistant working inside the current workspace.",
  "Use tools when you need to inspect local files.",
  "Use write only to create new files; it fails when the path already exists.",
  "Use edit to modify existing files by exact text replacement.",
  "Use bash when a shell command is the right way to inspect or change local state.",
  "Do not claim to have read a file unless you used the read tool or the content was provided directly.",
].join(" ");

export type LoadKanaSystemPromptOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type BuildKanaSystemPromptOptions = CollectKanaEnvironmentContextOptions & {
  env?: NodeJS.ProcessEnv;
  skills?: KanaSkill[];
};

export function loadKanaSystemPrompt(options: LoadKanaSystemPromptOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const { agentsPath } = getKanaConfigPaths(options.env);
  const projectAgentsPath = path.join(cwd, "AGENTS.md");
  const instructionBlocks: string[] = [DEFAULT_SYSTEM_PROMPT];

  if (existsSync(agentsPath)) {
    instructionBlocks[0] = formatAgentsInstructions("global", readFileSync(agentsPath, "utf8"));
  }

  // Project instructions are appended after global instructions so local
  // repository conventions have the more specific, later position.
  if (path.resolve(projectAgentsPath) !== path.resolve(agentsPath)) {
    if (existsSync(projectAgentsPath)) {
      instructionBlocks.push(
        formatAgentsInstructions("project", readFileSync(projectAgentsPath, "utf8")),
      );
    }
  }

  return instructionBlocks.join("\n\n");
}

export function buildKanaSystemPrompt(options: BuildKanaSystemPromptOptions = {}): string {
  const memoryPrompt = formatKanaMemoryForPrompt(options);
  const systemPrompt = loadKanaSystemPrompt({
    cwd: options.cwd,
    env: options.env,
  }).trimEnd();
  const environmentContext = formatKanaEnvironmentContext(collectKanaEnvironmentContext(options));
  const skillsPrompt = formatKanaSkillsForPrompt(options.skills ?? [], {
    env: options.env,
  });

  return [memoryPrompt, systemPrompt, environmentContext, skillsPrompt]
    .filter(Boolean)
    .join("\n\n");
}

function formatKanaMemoryForPrompt(options: BuildKanaSystemPromptOptions): string | undefined {
  if (!loadKanaConfig(options.env).memory.enabled) {
    return undefined;
  }

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
