import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { OAuthAuthorizationResponseError, OAuthError, OAuthProtocolError } from "./errors";

const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_CALLBACK_REDIRECT_URI = "http://127.0.0.1:0/oauth/callback";
const SAFE_OAUTH_ERROR = /^[a-zA-Z0-9_.-]{1,64}$/;

export type OAuthAuthorizationCallback = {
  code: string;
};

export type OAuthCallbackServer = {
  readonly redirectUri: string;
  waitForCallback(
    expectedState: string,
    options?: { signal?: AbortSignal },
  ): Promise<OAuthAuthorizationCallback>;
  close(): Promise<void>;
};

export type StartOAuthCallbackServerOptions = {
  redirectUri?: string;
  timeoutMs?: number;
};

type PendingCallback = {
  expectedState: string;
  resolve(value: OAuthAuthorizationCallback): void;
  reject(error: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
};

export async function startOAuthCallbackServer(
  options: StartOAuthCallbackServerOptions,
): Promise<OAuthCallbackServer> {
  assertPositiveInteger(options.timeoutMs, "timeoutMs");
  const redirectUri =
    options.redirectUri === undefined
      ? new URL(DEFAULT_CALLBACK_REDIRECT_URI)
      : parseLoopbackRedirectUri(options.redirectUri);
  const server = new LoopbackOAuthCallbackServer(
    redirectUri,
    options.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS,
  );
  await server.start();
  return server;
}

class LoopbackOAuthCallbackServer implements OAuthCallbackServer {
  private readonly server: Server;
  private readonly endpoint: URL;
  private pending?: PendingCallback;
  private state: "idle" | "running" | "closing" | "closed" = "idle";
  private closePromise?: Promise<void>;

  constructor(
    endpoint: URL,
    private readonly timeoutMs: number,
  ) {
    this.endpoint = new URL(endpoint);
    this.server = createServer((request, response) => this.handleRequest(request, response));
    this.server.on("error", (error) => this.rejectPending(error));
  }

  get redirectUri(): string {
    return this.endpoint.toString();
  }

  async start(): Promise<void> {
    if (this.state !== "idle") {
      throw new OAuthError("OAuth callback server can only be started once.");
    }
    this.state = "running";

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        this.state = "closed";
        reject(new OAuthError("Failed to start OAuth callback server.", { cause: error }));
      };
      const onListening = () => {
        this.server.off("error", onError);
        const address = this.server.address();
        if (!isAddressInfo(address)) {
          this.server.close();
          this.state = "closed";
          reject(new OAuthError("OAuth callback server did not expose a TCP address."));
          return;
        }
        // Port zero delegates allocation to the OS. The resolved port must be
        // reflected in both the authorization and token requests.
        this.endpoint.port = String(address.port);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(
        Number(this.endpoint.port),
        this.endpoint.hostname === "[::1]" ? "::1" : this.endpoint.hostname,
      );
    });
  }

  waitForCallback(
    expectedState: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<OAuthAuthorizationCallback> {
    if (this.state !== "running") {
      return Promise.reject(new OAuthError("OAuth callback server is not running."));
    }
    if (this.pending !== undefined) {
      return Promise.reject(new OAuthError("OAuth callback server is already waiting."));
    }
    if (!expectedState) {
      return Promise.reject(new OAuthProtocolError("OAuth callback state cannot be empty."));
    }
    if (options.signal?.aborted) {
      return Promise.reject(options.signal.reason ?? new OAuthError("OAuth callback was aborted."));
    }

    return new Promise<OAuthAuthorizationCallback>((resolve, reject) => {
      const pending: PendingCallback = {
        expectedState,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.rejectPending(new OAuthError("OAuth authorization callback timed out."));
        }, this.timeoutMs),
      };
      if (options.signal !== undefined) {
        const onAbort = () => {
          this.rejectPending(
            options.signal?.reason ?? new OAuthError("OAuth callback was aborted."),
          );
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }
      this.pending = pending;
    });
  }

  close(): Promise<void> {
    if (this.state === "closed") {
      return this.closePromise ?? Promise.resolve();
    }
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }

    this.state = "closing";
    this.rejectPending(new OAuthError("OAuth callback server closed."));
    this.closePromise = new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        this.state = "closed";
        if (error) {
          reject(new OAuthError("Failed to close OAuth callback server.", { cause: error }));
        } else {
          resolve();
        }
      });
    });
    return this.closePromise;
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    const requestUrl = new URL(request.url ?? "/", this.endpoint.origin);
    if (request.method !== "GET" || requestUrl.pathname !== this.endpoint.pathname) {
      respond(response, request.method === "GET" ? 404 : 405, "OAuth callback not found.");
      return;
    }

    const pending = this.pending;
    if (pending === undefined) {
      respond(response, 409, "No OAuth authorization is pending.");
      return;
    }
    if (requestUrl.searchParams.get("state") !== pending.expectedState) {
      respond(response, 400, "OAuth callback state did not match.");
      return;
    }

    const oauthError = requestUrl.searchParams.get("error");
    if (oauthError !== null) {
      respond(response, 400, "OAuth authorization was not completed.");
      this.rejectPending(
        new OAuthAuthorizationResponseError(
          SAFE_OAUTH_ERROR.test(oauthError) ? oauthError : "authorization_error",
        ),
      );
      return;
    }

    const code = requestUrl.searchParams.get("code");
    if (!code || code.length > 4_096) {
      respond(response, 400, "OAuth callback did not contain an authorization code.");
      this.rejectPending(new OAuthProtocolError("OAuth callback did not contain a code."));
      return;
    }

    respond(response, 200, "Authorization complete. You can return to Kana.");
    this.resolvePending({ code });
  }

  private resolvePending(value: OAuthAuthorizationCallback): void {
    const pending = this.takePending();
    pending?.resolve(value);
  }

  private rejectPending(error: unknown): void {
    const pending = this.takePending();
    pending?.reject(error);
  }

  private takePending(): PendingCallback | undefined {
    const pending = this.pending;
    if (pending === undefined) {
      return undefined;
    }
    this.pending = undefined;
    clearTimeout(pending.timeout);
    pending.removeAbortListener?.();
    return pending;
  }
}

function parseLoopbackRedirectUri(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new OAuthProtocolError("OAuth callback redirect URI must be an absolute URL.", {
      cause: error,
    });
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback) {
    throw new OAuthProtocolError("OAuth callback server requires an HTTP loopback redirect URI.");
  }
  if (!url.port) {
    throw new OAuthProtocolError("OAuth callback redirect URI must include an explicit port.");
  }
  if (url.port === "0") {
    throw new OAuthProtocolError(
      "OAuth callback redirect URI cannot explicitly use port zero; omit it to select a free port.",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new OAuthProtocolError(
      "OAuth callback redirect URI cannot contain credentials, query, or fragment.",
    );
  }
  return url;
}

function isAddressInfo(value: ReturnType<Server["address"]>): value is AddressInfo {
  return typeof value === "object" && value !== null;
}

function respond(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    Connection: "close",
    "Content-Security-Policy": "default-src 'none'",
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(message);
}

function assertPositiveInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new Error(`${name} must be a positive integer.`);
  }
}
