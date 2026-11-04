import { BaseModel, type ModelContext } from "@/core";
import { isContextWindowFailure, readOpenAIErrorSignals } from "../context-window";
import { createProviderRequestSignal, fetchWithRetries, joinUrl } from "../http";
import { createProviderDiagnostics, type ProviderDiagnostics } from "../lifecycle";
import { ResponsesStreamProcessor, type ResponsesStreamState } from "../responses";
import { assertOutputLimit, streamProviderRequest, toContextWindowError } from "../run";
import { readSseJson } from "../sse";
import { buildOpenAIResponsesRequest, getOpenAIResponsesReplayOwner } from "./request";
import type { OpenAIResponsesModelConfig } from "./types";

const LABEL = "OpenAI Responses-compatible provider";

export class OpenAIResponsesModel extends BaseModel {
  readonly metadata;
  private readonly diagnostics: ProviderDiagnostics;

  constructor(private readonly config: OpenAIResponsesModelConfig) {
    super();
    this.metadata = {
      ...config.metadata,
      provider: config.provider,
      model: config.model,
      protocol: "responses" as const,
    };
    this.diagnostics = createProviderDiagnostics(config.logger, {
      provider: config.provider,
      model: config.model,
      protocol: "responses",
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
          `OpenAI Responses-compatible model "${config.provider}/${config.model}"`,
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
          const body = JSON.stringify(buildOpenAIResponsesRequest(context, config));
          setPhase("http_request");
          const response = await fetchWithRetries(
            joinUrl(config.baseUrl, "/responses"),
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
          const state: ResponsesStreamState = {};
          const processor = new ResponsesStreamProcessor(stream, message, state, {
            provider: getOpenAIResponsesReplayOwner(config),
            providerLabel: LABEL,
          });
          await readSseJson(
            response,
            LABEL,
            (event) => processor.apply(event),
            requestSignal.refresh,
          );
          if (state.stopReason === undefined) {
            throw new Error(`${LABEL} stream ended before a terminal response event.`);
          }
          return { stopReason: state.stopReason, usage: state.usage };
        } finally {
          requestSignal.dispose();
        }
      },
    );
  }
}
