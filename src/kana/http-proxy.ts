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
  proxy: string | false,
  fetch: OAuthFetch = globalThis.fetch,
): OAuthFetch {
  if (proxy === false) {
    return createDirectHttpFetch(fetch);
  }
  const bunFetch = fetch as BunProxyFetch;
  return (input, init) => bunFetch(input, { ...init, proxy });
}

function createDirectHttpFetch(fetch: OAuthFetch): OAuthFetch {
  return (input, init) => {
    const hostname = new URL(input instanceof Request ? input.url : input).hostname;
    const previousUpper = process.env.NO_PROXY;
    const previousLower = process.env.no_proxy;
    process.env.NO_PROXY = appendNoProxyHost(previousUpper, hostname);
    process.env.no_proxy = appendNoProxyHost(previousLower, hostname);
    try {
      // Bun reads proxy routing synchronously when fetch is invoked. Restore
      // process state before yielding so other Kana requests retain their own
      // proxy policy while this request continues asynchronously.
      return fetch(input, init);
    } finally {
      restoreEnvironment("NO_PROXY", previousUpper);
      restoreEnvironment("no_proxy", previousLower);
    }
  };
}

function appendNoProxyHost(value: string | undefined, hostname: string): string {
  return value ? `${value},${hostname}` : hostname;
}

function restoreEnvironment(name: "NO_PROXY" | "no_proxy", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
