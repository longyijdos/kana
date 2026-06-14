import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { getKanaConfigPaths } from "./config";
import {
  collectKanaEnvironmentContext,
  formatKanaEnvironmentContext,
  type CollectKanaEnvironmentContextOptions,
} from "./context";
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

export type BuildKanaSystemPromptOptions =
  CollectKanaEnvironmentContextOptions & {
    env?: NodeJS.ProcessEnv;
    skills?: KanaSkill[];
  };

export function loadKanaSystemPrompt(
  options: LoadKanaSystemPromptOptions = {},
): string {
  const cwd = options.cwd ?? process.cwd();
  const { agentsPath } = getKanaConfigPaths(options.env);
  const projectAgentsPath = path.join(cwd, "AGENTS.md");
  const instructionBlocks: string[] = [DEFAULT_SYSTEM_PROMPT];

  if (existsSync(agentsPath)) {
    instructionBlocks[0] = formatAgentsInstructions(
      "global",
      agentsPath,
      readFileSync(agentsPath, "utf8"),
    );
  }

  // Project instructions are appended after global instructions so local
  // repository conventions have the more specific, later position.
  if (path.resolve(projectAgentsPath) !== path.resolve(agentsPath)) {
    if (existsSync(projectAgentsPath)) {
      instructionBlocks.push(
        formatAgentsInstructions(
          "project",
          projectAgentsPath,
          readFileSync(projectAgentsPath, "utf8"),
        ),
      );
    }
  }

  return instructionBlocks.join("\n\n");
}

export function buildKanaSystemPrompt(
  options: BuildKanaSystemPromptOptions = {},
): string {
  const systemPrompt = loadKanaSystemPrompt({
    cwd: options.cwd,
    env: options.env,
  }).trimEnd();
  const environmentContext = formatKanaEnvironmentContext(
    collectKanaEnvironmentContext(options),
  );
  const skillsPrompt = formatKanaSkillsForPrompt(options.skills ?? [], {
    env: options.env,
  });

  return [systemPrompt, environmentContext, skillsPrompt]
    .filter(Boolean)
    .join("\n\n");
}

function formatAgentsInstructions(
  scope: "global" | "project",
  filePath: string,
  content: string,
): string {
  return [
    `<agents_instructions scope="${scope}" path="${escapeXml(filePath)}">`,
    content.trimEnd(),
    "</agents_instructions>",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
