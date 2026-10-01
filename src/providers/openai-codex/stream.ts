import type { AssistantEventStream, AssistantMessage } from "@/core";
import { ResponsesStreamProcessor, readResponsesStream } from "../responses";
import type { OpenAICodexStreamState } from "./types";

export class OpenAICodexStreamProcessor extends ResponsesStreamProcessor {
  constructor(
    stream: AssistantEventStream,
    message: AssistantMessage,
    state: OpenAICodexStreamState,
  ) {
    super(stream, message, state, {
      provider: "openai-codex",
      providerLabel: "OpenAI Codex",
    });
  }

  override apply(event: Record<string, unknown>): void {
    if (event.type === "response.done") return;
    super.apply(event);
  }
}

export function readOpenAICodexStream(
  response: Response,
  onEvent: (event: Record<string, unknown>) => void,
  onActivity?: () => void,
): Promise<void> {
  return readResponsesStream(response, onEvent, "OpenAI Codex", onActivity);
}
