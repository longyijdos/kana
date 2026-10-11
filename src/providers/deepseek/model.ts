import { BaseModel, type HostedToolAction, type ModelContext } from "@/core";
import { isContextWindowFailure, readOpenAIErrorSignals } from "../context-window";
import { createProviderRequestSignal, fetchWithRetries, joinUrl } from "../http";
import { createProviderDiagnostics, type ProviderDiagnostics } from "../lifecycle";
import { ResponsesStreamProcessor, type ResponsesStreamState } from "../responses";
import { assertOutputLimit, streamProviderRequest, toContextWindowError } from "../run";
import { readSseJson } from "../sse";
import { type DeepSeekModelMetadata, getDeepSeekModelMetadata } from "./metadata";
import { buildDeepSeekRequest } from "./request";
import type { DeepSeekModelConfig } from "./types";

const DEFAULT_BASE_URL = "https://api.deepseek.com";

export class DeepSeekModel extends BaseModel {
  readonly metadata: DeepSeekModelMetadata;
  private readonly diagnostics: ProviderDiagnostics;

  constructor(private readonly config: DeepSeekModelConfig) {
    super();
    this.metadata = getDeepSeekModelMetadata(config.model);
    this.diagnostics = createProviderDiagnostics(config.logger, {
      provider: "deepseek",
      model: config.model,
      protocol: this.metadata.protocol,
    });
  }

  stream(context: ModelContext) {
    const config = this.config;
    return streamProviderRequest(
      context,
      {
        diagnostics: this.diagnostics,
        normalizeError: (error) =>
          toContextWindowError(error, "DeepSeek", (httpError) =>
            isContextWindowFailure({
              status: httpError.status,
              ...readOpenAIErrorSignals(httpError.body),
            }),
          ),
      },
      async ({ stream, message, setPhase }) => {
        assertOutputLimit(
          `DeepSeek model "${config.model}"`,
          this.metadata.maxOutputTokens,
          context.maxOutputTokens,
        );
        setPhase("request_build");
        const body = JSON.stringify(buildDeepSeekRequest(context, config));
        setPhase("http_request");
        const requestSignal = createProviderRequestSignal({
          timeoutMs: config.timeoutMs,
          signal: context.signal,
          timeoutMessage: `DeepSeek request timed out after ${config.timeoutMs}ms.`,
        });
        try {
          const response = await fetchWithRetries(
            joinUrl(config.baseUrl ?? DEFAULT_BASE_URL, "/responses"),
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "text/event-stream",
                authorization: `Bearer ${config.apiKey}`,
              },
              body,
              signal: requestSignal.signal,
            },
            {
              label: "DeepSeek API",
              maxRetries: config.maxRetries ?? 0,
              onRetry: (details) => this.diagnostics.retrying(details),
            },
          );
          requestSignal.refresh();
          stream.push({ type: "start", snapshot: message.snapshot() });

          setPhase("response_stream");
          const state: ResponsesStreamState = {};
          const processor = new ResponsesStreamProcessor(stream, message, state, {
            provider: "deepseek",
            providerLabel: "DeepSeek",
            normalizeHostedToolAction: normalizeDeepSeekHostedToolAction,
          });
          await readSseJson(
            response,
            "DeepSeek",
            (event) => processor.apply(event),
            requestSignal.refresh,
          );
          if (state.stopReason === undefined) {
            throw new Error("DeepSeek stream ended before a terminal response event.");
          }
          return { stopReason: state.stopReason, usage: state.usage };
        } finally {
          requestSignal.dispose();
        }
      },
    );
  }
}

function normalizeDeepSeekHostedToolAction(
  action: HostedToolAction,
  item: Readonly<Record<string, unknown>>,
): HostedToolAction {
  const itemId = typeof item.id === "string" ? item.id : undefined;
  if (itemId === undefined) {
    return action;
  }

  // DeepSeek appends its replay correlation marker to user-facing queries and
  // URL fragments. Keep it in providerState, but not in the semantic action.
  const marker = `ws_call_id=${itemId}`;
  const { query, queries, url, ...rest } = action;
  const visibleQueries = queries?.filter((candidate) => candidate !== marker);
  return {
    ...rest,
    ...(query === undefined || query === marker ? {} : { query }),
    ...(visibleQueries?.length ? { queries: visibleQueries } : {}),
    ...(url === undefined
      ? {}
      : { url: url.endsWith(`#${marker}`) ? url.slice(0, -(marker.length + 1)) : url }),
  };
}
