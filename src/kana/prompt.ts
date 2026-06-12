import { existsSync, readFileSync } from "node:fs";

import { getKanaConfigPaths } from "./config";
import {
  collectKanaEnvironmentContext,
  formatKanaEnvironmentContext,
  type CollectKanaEnvironmentContextOptions,
} from "./context";

const DEFAULT_SYSTEM_PROMPT = [
  "You are a concise coding assistant working inside the current workspace.",
  "Use tools when you need to inspect local files.",
  "Use write only to create new files; it fails when the path already exists.",
  "Use edit to modify existing files by exact text replacement.",
  "Use bash when a shell command is the right way to inspect or change local state.",
  "Do not claim to have read a file unless you used the read tool or the content was provided directly.",
].join(" ");

export function loadKanaSystemPrompt(): string {
  const { agentsPath } = getKanaConfigPaths();

  if (!existsSync(agentsPath)) {
    return DEFAULT_SYSTEM_PROMPT;
  }

  return readFileSync(agentsPath, "utf8");
}

export function buildKanaSystemPrompt(
  options: CollectKanaEnvironmentContextOptions = {},
): string {
  const systemPrompt = loadKanaSystemPrompt().trimEnd();
  const environmentContext = formatKanaEnvironmentContext(
    collectKanaEnvironmentContext(options),
  );

  return `${systemPrompt}\n\n${environmentContext}`;
}
