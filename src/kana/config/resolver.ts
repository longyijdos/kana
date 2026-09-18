import type { KanaAgentRuntimeConfig, KanaConfig, KanaModelConfig } from "./contracts";

// Memory consolidation declares only the model fields it overrides; every other
// field follows the conversation Agent's model.
export function resolveKanaMemoryAgentConfig(
  config: KanaConfig,
): KanaAgentRuntimeConfig & { model: KanaModelConfig } {
  const { model } = config.memory.agent;

  return {
    ...config.memory.agent,
    model: {
      provider: model.provider ?? config.agent.model.provider,
      name: model.name ?? config.agent.model.name,
      reasoningEffort: model.reasoningEffort ?? config.agent.model.reasoningEffort,
      maxOutputTokens: model.maxOutputTokens ?? config.agent.model.maxOutputTokens,
      contextLimit: model.contextLimit ?? config.agent.model.contextLimit,
    },
  };
}
