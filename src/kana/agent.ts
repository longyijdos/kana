import { Agent, type AgentConfig } from "@/agent";
import { getModel } from "@/providers";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@/tools";
import { getKanaConfigPaths, type KanaConfig } from "./config";
import { loadKanaSystemPrompt } from "./prompt";

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
    system: loadKanaSystemPrompt(),
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
