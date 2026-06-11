import { Agent, type AgentConfig } from "@/agent";
import { getModel } from "@/providers";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@/tools";
import { getKanaConfigPaths, type KanaConfig } from "./config";

type KanaAgentOptions = Pick<AgentConfig, "beforeToolExecution">;

export function createKanaAgent(
  config: KanaConfig,
  options: KanaAgentOptions = {},
): Agent {
  const apiKey = process.env[config.model.apiKeyEnv];

  if (!apiKey) {
    throw new Error(
      `Missing ${config.model.apiKeyEnv}. Set it in your environment or update ${getKanaConfigPaths().configPath}.`,
    );
  }

  const model = getModel({
    provider: config.model.provider,
    model: config.model.name,
    apiKey,
    thinking: config.model.thinking,
    reasoningEffort: config.model.reasoningEffort,
    maxTokens: config.model.maxTokens,
    timeoutMs: config.model.timeoutMs,
    maxRetries: config.model.maxRetries,
  });

  return new Agent({
    model,
    system: [
      "You are a concise coding assistant working inside the current workspace.",
      "Use tools when you need to inspect local files.",
      "Use write only to create new files; it fails when the path already exists.",
      "Use edit to modify existing files by exact text replacement.",
      "Use bash when a shell command is the right way to inspect or change local state.",
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
    maxTurns: config.agent.maxTurns,
    beforeToolExecution: options.beforeToolExecution,
  });
}
