import { Agent, type AgentConfig } from "@/agent";
import { getModel } from "@/providers";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@/tools";
import { getKanaConfigPaths, type KanaConfig } from "./config";
import { buildKanaSystemPrompt } from "./prompt";

type KanaAgentOptions = Pick<
  AgentConfig,
  "beforeToolExecution" | "messages" | "onRunCommitted"
>;

export function createKanaAgent(
  config: KanaConfig,
  options: KanaAgentOptions = {},
): Agent {
  const cwd = process.cwd();
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
    system: buildKanaSystemPrompt({ cwd }),
    tools: [
      createReadTool({
        root: cwd,
      }),
      createWriteTool({
        root: cwd,
      }),
      createEditTool({
        root: cwd,
      }),
      createBashTool({
        root: cwd,
      }),
    ],
    maxTurns: config.agent.maxTurns,
    beforeToolExecution: options.beforeToolExecution,
    messages: options.messages,
    onRunCommitted: options.onRunCommitted,
  });
}
