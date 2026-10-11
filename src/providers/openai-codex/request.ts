import type { ModelContext } from "@/core";
import { toResponsesInput, toResponsesTools } from "../responses";
import type { OpenAICodexModelConfig } from "./types";

const TOOL_NAMESPACE = "kana";

export function buildOpenAICodexRequest(
  context: ModelContext,
  config: OpenAICodexModelConfig,
): Record<string, unknown> {
  const tools = toResponsesTools(context.tools ?? [], { strict: false, namespace: TOOL_NAMESPACE });
  if (context.webSearch) {
    tools.push({ type: "web_search" });
  }

  // The SIWC preview contract does not expose max_output_tokens, so
  // configured and per-request output ceilings stay local to Kana.
  return {
    model: config.model,
    store: false,
    stream: true,
    instructions: context.system || "You are a helpful assistant.",
    // Reasoning text is only a user-facing summary; without the opaque item it
    // must not be sent back as model input.
    input: toResponsesInput(context.messages, {
      provider: "openai-codex",
      imageInput: context.imageInput === true,
      replayReasoningText: false,
      stateless: true,
      namespace: TOOL_NAMESPACE,
    }),
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    tools,
    tool_choice: "auto",
    parallel_tool_calls: context.parallelToolCalls === true,
    ...(config.sessionId === undefined ? {} : { prompt_cache_key: config.sessionId }),
    ...(config.reasoningEffort === undefined
      ? {}
      : {
          reasoning: { effort: config.reasoningEffort, summary: config.reasoningSummary ?? "auto" },
        }),
  };
}
