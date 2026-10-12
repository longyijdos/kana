export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

// Safe log metadata: the error class and fixed-format code, never the message.
export function errorFields(error: unknown): { errorType: string; errorCode?: string } {
  const code = errorCode(error);
  return {
    errorType: error instanceof Error ? error.name : typeof error,
    ...(code === undefined ? {} : { errorCode: code }),
  };
}
