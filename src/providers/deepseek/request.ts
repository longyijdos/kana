import type { ModelContext } from "@/core";
import { toResponsesInput, toResponsesTools } from "../responses";
import type { DeepSeekModelConfig } from "./types";

export function buildDeepSeekRequest(
  context: ModelContext,
  config: DeepSeekModelConfig,
): Record<string, unknown> {
  const tools = toResponsesTools(context.tools ?? [], {});
  if (context.webSearch) {
    const isFlash = config.model === "deepseek-flash";
    if (isFlash && config.reasoningEffort === "none" && tools.length > 0) {
      throw new Error(
        'DeepSeek Flash cannot combine web search and function tools with reasoning_effort = "none". ' +
          'Set reasoning_effort to "low" or higher, or set web_search = false.',
      );
    }
    tools.push({ type: isFlash ? "deepseek_web_search" : "web_search" });
  }
  return {
    model: config.model,
    instructions: context.system || "You are a helpful assistant.",
    // DeepSeek Responses is stateless and documents completed output items,
    // including web searches, as replayable input.
    input: toResponsesInput(context.messages, {
      provider: "deepseek",
      imageInput: context.imageInput === true,
      replayReasoningText: true,
    }),
    stream: true,
    ...(context.maxOutputTokens === undefined
      ? {}
      : { max_output_tokens: context.maxOutputTokens }),
    ...(config.reasoningEffort === undefined
      ? {}
      : { reasoning: { effort: config.reasoningEffort } }),
    ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
  };
}
