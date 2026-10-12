import { BaseModel, type ModelContext } from "@/core";
import { isContextWindowFailure, readOpenAIErrorSignals } from "../context-window";
import { createProviderRequestSignal, fetchWithRetries, joinUrl } from "../http";
import { createProviderDiagnostics, type ProviderDiagnostics } from "../lifecycle";
import { assertOutputLimit, streamProviderRequest, toContextWindowError } from "../run";
import { readSseJson } from "../sse";
import { buildOpenAICompatibleRequest } from "./request";
import {
  applyOpenAICompatibleChunk,
  finishOpenAICompatibleAssistantReplay,
  finishOpenAICompatibleContent,
  finishOpenAICompatibleToolCalls,
  getOpenAICompatibleDoneReason,
} from "./stream";
import type {
  OpenAICompatibleChunk,
  OpenAICompatibleModelConfig,
  OpenAICompatibleStreamState,
} from "./types";

const LABEL = "OpenAI-compatible provider";

export class OpenAICompatibleModel extends BaseModel {
  readonly metadata;
  private readonly diagnostics: ProviderDiagnostics;

  constructor(private readonly config: OpenAICompatibleModelConfig) {
    super();
    this.metadata = {
      ...config.metadata,
      provider: config.provider,
      model: config.model,
      protocol: "chat-completions" as const,
    };
    this.diagnostics = createProviderDiagnostics(config.logger, {
      provider: config.provider,
      model: config.model,
      protocol: "chat-completions",
    });
  }

  stream(context: ModelContext) {
    const config = this.config;
    return streamProviderRequest(
      context,
      {
        diagnostics: this.diagnostics,
        normalizeError: (error) =>
          toContextWindowError(error, config.provider, (httpError) =>
            isContextWindowFailure({
              status: httpError.status,
              ...readOpenAIErrorSignals(httpError.body),
            }),
          ),
      },
      async ({ stream, message, setPhase }) => {
        assertOutputLimit(
          `OpenAI-compatible model "${config.provider}/${config.model}"`,
          this.metadata.maxOutputTokens,
          config.maxOutputTokens,
          context.maxOutputTokens,
        );
        const requestSignal = createProviderRequestSignal({
          timeoutMs: config.timeoutMs,
          signal: context.signal,
          timeoutMessage: `${LABEL} ${config.provider}/${config.model} timed out after ${config.timeoutMs}ms of inactivity.`,
        });
        try {
          setPhase("request_build");
          const body = JSON.stringify(buildOpenAICompatibleRequest(context, config));
          setPhase("http_request");
          const response = await fetchWithRetries(
            joinUrl(config.baseUrl, "/chat/completions"),
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "text/event-stream",
                ...config.headers,
                ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
              },
              body,
              signal: requestSignal.signal,
              // Redirects can forward authorization headers to a different
              // origin, so compatible endpoints must expose their final URL.
              redirect: "error",
            },
            {
              label: LABEL,
              maxRetries: config.maxRetries ?? 0,
              onRetry: (details) => this.diagnostics.retrying(details),
            },
          );
          requestSignal.refresh();
          stream.push({ type: "start", snapshot: message.snapshot() });

          setPhase("response_stream");
          const replayFields = config.metadata.assistantReplayFields;
          const state: OpenAICompatibleStreamState = {
            endedContentIndexes: new Set<number>(),
            ...(replayFields?.length
              ? {
                  assistantReplay: {
                    provider: config.provider,
                    model: config.model,
                    baseUrl: config.baseUrl,
                    fields: new Set(replayFields),
                    values: new Map<string, unknown>(),
                  },
                }
              : {}),
          };
          await readSseJson(
            response,
            LABEL,
            (chunk) =>
              applyOpenAICompatibleChunk(stream, message, state, chunk as OpenAICompatibleChunk),
            requestSignal.refresh,
          );
          finishOpenAICompatibleContent(stream, message, state);
          const hasToolCalls = message.content.some((content) => content.type === "tool_call");
          const finishReason = state.finishReason ?? (hasToolCalls ? "tool_calls" : undefined);
          if (finishReason === "tool_calls") {
            if (!hasToolCalls) {
              throw new Error(`${LABEL} finished with tool_calls but returned no tool call.`);
            }
            finishOpenAICompatibleToolCalls(stream, message, state);
          } else if (hasToolCalls) {
            throw new Error(`${LABEL} returned tool calls with finish reason ${finishReason}.`);
          }
          finishOpenAICompatibleAssistantReplay(message, state);
          return { stopReason: getOpenAICompatibleDoneReason(finishReason), usage: state.usage };
        } finally {
          requestSignal.dispose();
        }
      },
    );
  }
}
