import type { OAuthFetch } from "@/oauth";

type BunProxyRequestInit = RequestInit & {
  proxy: string;
};

type BunProxyFetch = (
  input: string | URL | Request,
  init?: BunProxyRequestInit,
) => Promise<Response>;

// Bun exposes proxy routing as a fetch extension rather than a standard
// RequestInit field. Keep that runtime-specific detail at the composition
// boundary so MCP transport and OAuth can continue using fetch-compatible APIs.
export function createHttpProxyFetch(
  proxy: string,
  fetch: OAuthFetch = globalThis.fetch,
): OAuthFetch {
  const bunFetch = fetch as BunProxyFetch;
  return (input, init) => bunFetch(input, { ...init, proxy });
}
