import type { ModelContext } from "./context";
import type { AssistantMessage } from "./messages";
import type { ReadableAssistantMessageStream } from "./stream";

export type ModelOptions = {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
};

export interface ModelProvider<
  TOptions extends ModelOptions = ModelOptions,
> {
  // Providers implement the streaming path only. Non-streaming generation is
  // derived from the stream result helper below.
  stream(
    context: ModelContext,
    options?: TOptions,
  ): ReadableAssistantMessageStream;
}

export function stream<TOptions extends ModelOptions>(
  provider: ModelProvider<TOptions>,
  context: ModelContext,
  options?: TOptions,
): ReadableAssistantMessageStream {
  return provider.stream(context, options);
}

export function generate<TOptions extends ModelOptions>(
  provider: ModelProvider<TOptions>,
  context: ModelContext,
  options?: TOptions,
): Promise<AssistantMessage> {
  // Keep one behavioral path: generate is just stream collection.
  return stream(provider, context, options).result();
}
