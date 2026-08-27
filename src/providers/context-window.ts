const CONTEXT_WINDOW_STATUSES = new Set([400, 413, 422]);
const DEFAULT_CONTEXT_MESSAGE_LIMIT = 4_096;

export type ProviderErrorSignals = {
  code?: string;
  message: string;
};

export function readOpenAIErrorSignals(body: string): ProviderErrorSignals {
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        code?: unknown;
        message?: unknown;
      };
    };
    return {
      ...(typeof parsed.error?.code === "string" ? { code: parsed.error.code } : {}),
      message: typeof parsed.error?.message === "string" ? parsed.error.message : body,
    };
  } catch {
    return { message: body };
  }
}

export function isContextWindowFailure(options: {
  status: number;
  code?: string;
  message: string;
  messageLimit?: number;
  providerSignal?: boolean;
  includeCommonMessageSignals?: boolean;
}): boolean {
  if (!CONTEXT_WINDOW_STATUSES.has(options.status)) {
    return false;
  }

  const message = options.message.slice(0, options.messageLimit ?? DEFAULT_CONTEXT_MESSAGE_LIMIT);
  return (
    options.providerSignal === true ||
    (options.code !== undefined &&
      /context[_ -]?(length|window)[_ -]?exceeded/i.test(options.code)) ||
    (options.includeCommonMessageSignals !== false &&
      (/(maximum|max).{0,32}context.{0,32}(length|window)|context.{0,32}(length|window).{0,32}(exceed|too (?:long|large))/i.test(
        message,
      ) ||
        /(?:input|prompt).{0,32}(?:token|length).{0,32}(?:exceed|too (?:long|large))/i.test(
          message,
        )))
  );
}
