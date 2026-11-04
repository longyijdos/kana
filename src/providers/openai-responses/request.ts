import type { ModelContext } from "@/core";
import { toResponsesInput, toResponsesTools } from "../responses";
import type { OpenAIResponsesModelConfig } from "./types";

export function buildOpenAIResponsesRequest(
  context: ModelContext,
  config: OpenAIResponsesModelConfig,
): Record<string, unknown> {
  // Responses defaults function tools to strict schemas, which Kana's tool
  // schemas do not guarantee.
  const tools = toResponsesTools(context.tools ?? [], { strict: false });
  if (context.webSearch) {
    tools.push({ type: "web_search" });
  }
  const maxOutputTokens = context.maxOutputTokens ?? config.maxOutputTokens;

  return {
    model: config.model,
    ...(context.system ? { instructions: context.system } : {}),
    // Compatible endpoints are not assumed to retain server-side items, so
    // history replays stored items without IDs and with encrypted reasoning.
    input: toResponsesInput(context.messages, {
      provider: getOpenAIResponsesReplayOwner(config),
      imageInput: context.imageInput === true,
      replayReasoningText: false,
      stateless: true,
    }),
    stream: true,
    store: false,
    ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
    ...(config.reasoningEffort === undefined
      ? {}
      : {
          include: ["reasoning.encrypted_content"],
          reasoning: { effort: config.reasoningEffort, summary: "auto" },
        }),
    ...(tools.length > 0
      ? {
          tools,
          tool_choice: "auto",
          ...(context.parallelToolCalls === undefined
            ? {}
            : { parallel_tool_calls: context.parallelToolCalls }),
        }
      : {}),
  };
}

// Encrypted reasoning and hosted-tool items are only valid for the endpoint
// and model that produced them, so the replay owner carries both.
export function getOpenAIResponsesReplayOwner(config: OpenAIResponsesModelConfig): string {
  return `${config.provider}:responses:${config.baseUrl}#${config.model}`;
}
