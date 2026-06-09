import { Agent } from "../agent";
import { getModel } from "../providers";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "../tools";

export function createKanaAgent(apiKey: string): Agent {
  const model = getModel({
    provider: "deepseek",
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
    apiKey,
    thinking: true,
    reasoningEffort: "high",
    maxTokens: 8192,
    timeoutMs: 60_000,
    maxRetries: 1,
  });

  return new Agent({
    model,
    system: [
      "You are a concise coding assistant working inside the current workspace.",
      "Use tools when you need to inspect local files.",
      "Use write only to create new files; it fails when the path already exists.",
      "Use edit to modify existing files by exact text replacement.",
      "Use bash only for allowlisted, non-destructive commands and project checks.",
      "Do not claim to have read a file unless you used the read tool or the content was provided directly.",
    ].join(" "),
    tools: [
      createReadTool({
        root: process.cwd(),
      }),
      createWriteTool({
        root: process.cwd(),
      }),
      createEditTool({
        root: process.cwd(),
      }),
      createBashTool({
        root: process.cwd(),
      }),
    ],
    maxTurns: -1,
  });
}
