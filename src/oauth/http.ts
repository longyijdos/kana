import { OAuthProtocolError } from "./errors";

export const DEFAULT_OAUTH_MAX_RESPONSE_BYTES = 256 * 1024;

export async function readOAuthJsonResponse(
  response: Response,
  maxResponseBytes: number,
): Promise<unknown> {
  if (!response.body) {
    throw new OAuthProtocolError("OAuth endpoint returned an empty response body.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new OAuthProtocolError(`OAuth response exceeds the ${maxResponseBytes}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch (error) {
    throw new OAuthProtocolError("OAuth endpoint returned invalid JSON.", { cause: error });
  }
}

export function describeOAuthErrorIdentity(error: unknown): string {
  if (!(error instanceof Error)) {
    return `thrown ${typeof error}`;
  }

  const parts = [error.name || "Error"];
  const code = readSafeErrorCode(error);
  if (code !== undefined) {
    parts.push(`code ${code}`);
  }
  const cause = error.cause;
  if (cause instanceof Error && cause !== error) {
    const causeCode = readSafeErrorCode(cause);
    parts.push(`cause ${cause.name || "Error"}${causeCode === undefined ? "" : `/${causeCode}`}`);
  }
  return parts.join(", ");
}

export function assertOAuthMaxResponseBytes(value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new Error("maxResponseBytes must be a positive integer.");
  }
}

function readSafeErrorCode(error: Error): string | undefined {
  const code = (error as Error & { code?: unknown }).code;
  const value = typeof code === "string" || typeof code === "number" ? String(code) : undefined;
  return value !== undefined && /^[a-zA-Z0-9_.-]{1,64}$/.test(value) ? value : undefined;
}
