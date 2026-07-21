import {
  discoverOAuthAuthorizationServer,
  type OAuthClientCredentials,
  type OAuthDiagnosticEvent,
  type OAuthFetch,
  OAuthSession,
  type OAuthTokenStore,
} from "@/oauth";
import {
  canonicalizeMcpResource,
  createMcpAuthorizationChallengeError,
  discoverMcpProtectedResource,
  McpAuthorizationChallengeError,
  type McpAuthorizationDiagnosticEvent,
  type McpBearerChallenge,
  type McpProtectedResourceMetadata,
  selectMcpAuthorizationScopes,
} from "./authorization";
import { McpTransportError } from "./transport";

export type McpOAuthHttpLifecycleDiagnosticEvent =
  | {
      event: "mcp.oauth_preparation_started";
      level: "info";
    }
  | {
      event: "mcp.oauth_preparation_succeeded";
      level: "info";
      interactiveAuthorization: boolean;
    }
  | {
      event: "mcp.oauth_preparation_failed";
      level: "warn";
      errorIdentity: string;
    }
  | {
      event: "mcp.oauth_challenge_probe_started";
      level: "debug";
    }
  | {
      event: "mcp.oauth_challenge_probe_succeeded";
      level: "info";
      status: 401 | 403;
    }
  | {
      event: "mcp.oauth_challenge_probe_failed";
      level: "debug";
      status?: number;
      errorIdentity?: string;
    }
  | {
      event: "mcp.oauth_challenge_received";
      level: "info";
      status: 401 | 403;
      kind: "authorization_required" | "insufficient_scope";
      requestHadCredentials: boolean;
    }
  | {
      event: "mcp.oauth_request_retried";
      level: "info";
      recovery: "stored_token" | "refreshed_token" | "interactive_authorization";
    }
  | {
      event: "mcp.oauth_retry_rejected";
      level: "warn";
      status: 401 | 403;
      kind: "authorization_required" | "insufficient_scope";
    }
  | {
      event: "mcp.oauth_scope_challenge_blocked";
      level: "warn";
      configuredScopeCount: number;
      challengedScopeCount: number;
      missingScopeCount: number;
    };

export type McpOAuthHttpDiagnosticEvent =
  | McpOAuthHttpLifecycleDiagnosticEvent
  | McpAuthorizationDiagnosticEvent
  | OAuthDiagnosticEvent;

export type McpOAuthHttpAuthorizerOptions = {
  resource: string;
  storageKey: string;
  client: OAuthClientCredentials;
  tokenStore: OAuthTokenStore;
  openAuthorizationUrl(url: string): Promise<void>;
  redirectUri?: string;
  scopes?: readonly string[];
  additionalAuthorizationParameters?: Readonly<Record<string, string>>;
  callbackTimeoutMs?: number;
  fetch?: OAuthFetch;
  signal?: AbortSignal;
  onDiagnostic?(event: McpOAuthHttpDiagnosticEvent): void;
};

type AuthorizationRecovery = {
  token: string;
  recovery: "stored_token" | "refreshed_token" | "interactive_authorization";
};

// This adapter owns OAuth state for one MCP protected resource. It exposes a
// fetch-compatible boundary to Streamable HTTP so transport framing, MCP
// sessions, and OAuth token rotation remain independent state machines.
export class McpOAuthHttpAuthorizer {
  private readonly endpoint: URL;
  private readonly resource: string;
  private readonly rawFetch: OAuthFetch;
  private readonly lifecycle: AbortController;
  private readonly disposeExternalSignal: () => void;
  private protectedResource?: McpProtectedResourceMetadata;
  private session?: OAuthSession;
  private sessionPromise?: Promise<OAuthSession>;
  private recoveryPromise?: Promise<AuthorizationRecovery>;
  private preparationPromise?: Promise<void>;
  private lastAccessToken?: string;
  private closing = false;
  private closed = false;

  constructor(private readonly options: McpOAuthHttpAuthorizerOptions) {
    this.endpoint = parseEndpoint(options.resource);
    this.resource = canonicalizeMcpResource(options.resource);
    this.rawFetch = options.fetch ?? globalThis.fetch;
    const linked = createLinkedAbortController(options.signal);
    this.lifecycle = linked.controller;
    this.disposeExternalSignal = linked.dispose;
    if (!options.storageKey) {
      throw new Error("MCP OAuth storage key cannot be empty.");
    }
  }

  readonly fetch: OAuthFetch = async (input, init) => {
    const request = this.createRequestTemplate(input, init);
    const method = request.method.toUpperCase();
    if (this.closed || (this.closing && method !== "DELETE")) {
      throw new McpTransportError("MCP OAuth authorizer is closing or closed.");
    }
    const accessToken = this.closing ? this.lastAccessToken : await this.session?.getAccessToken();
    if (accessToken !== undefined) {
      this.lastAccessToken = accessToken;
    }
    const response = await this.rawFetch(this.createAttempt(request, accessToken));
    const challenge = await readAuthorizationChallenge(response);
    if (challenge === undefined || method === "DELETE") {
      return response;
    }

    this.emit({
      event: "mcp.oauth_challenge_received",
      level: "info",
      status: challenge.status,
      kind: challenge.kind,
      requestHadCredentials: accessToken !== undefined,
    });
    await response.body?.cancel().catch(() => undefined);

    const recovery = await this.recoverAuthorization(challenge, accessToken !== undefined);
    this.lastAccessToken = recovery.token;
    this.emit({
      event: "mcp.oauth_request_retried",
      level: "info",
      recovery: recovery.recovery,
    });
    const retried = await this.rawFetch(this.createAttempt(request, recovery.token));
    const retryChallenge = await readAuthorizationChallenge(retried);
    if (retryChallenge !== undefined) {
      this.emit({
        event: "mcp.oauth_retry_rejected",
        level: "warn",
        status: retryChallenge.status,
        kind: retryChallenge.kind,
      });
    }
    return retried;
  };

  prepare(): Promise<void> {
    this.assertOpen();
    if (this.preparationPromise !== undefined) {
      return this.preparationPromise;
    }

    const promise = this.prepareInternal();
    this.preparationPromise = promise;
    return promise;
  }

  async authorize(): Promise<void> {
    this.assertOpen();
    const session = await this.ensurePreparationSession();
    this.lastAccessToken = await session.authorize({ scopes: this.selectScopes() });
  }

  beginClose(): void {
    if (this.closing || this.closed) {
      return;
    }
    this.closing = true;
    if (this.session === undefined) {
      this.lifecycle.abort(new McpTransportError("MCP OAuth authorizer is closing."));
    } else {
      this.session.cancelPending(new McpTransportError("MCP OAuth authorizer is closing."));
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.beginClose();
    this.closed = true;
    this.lifecycle.abort(new McpTransportError("MCP OAuth authorizer closed."));
    this.session?.close();
    this.lastAccessToken = undefined;
    this.disposeExternalSignal();
  }

  private async prepareInternal(): Promise<void> {
    this.emit({ event: "mcp.oauth_preparation_started", level: "info" });
    try {
      const session = await this.ensurePreparationSession();
      const existingToken = await session.getAccessToken();
      const interactiveAuthorization = existingToken === undefined;
      if (existingToken === undefined) {
        this.lastAccessToken = await session.authorize({ scopes: this.selectScopes() });
      } else {
        this.lastAccessToken = existingToken;
      }
      this.emit({
        event: "mcp.oauth_preparation_succeeded",
        level: "info",
        interactiveAuthorization,
      });
    } catch (error) {
      this.emit({
        event: "mcp.oauth_preparation_failed",
        level: "warn",
        errorIdentity: describeErrorIdentity(error),
      });
      throw error;
    }
  }

  private async ensurePreparationSession(): Promise<OAuthSession> {
    try {
      return await this.ensureSession();
    } catch (discoveryError) {
      // A server may publish resource metadata only through its Bearer
      // challenge. Probe with an idempotent method before MCP initialize so
      // interactive authorization is not constrained by initialize timeout.
      if (this.protectedResource !== undefined) {
        throw discoveryError;
      }
      const challenge = await this.probeAuthorizationChallenge(discoveryError);
      return this.ensureSession(challenge);
    }
  }

  private async probeAuthorizationChallenge(discoveryError: unknown): Promise<McpBearerChallenge> {
    this.emit({ event: "mcp.oauth_challenge_probe_started", level: "debug" });
    let response: Response;
    try {
      response = await this.rawFetch(this.endpoint, {
        method: "HEAD",
        headers: { Accept: "application/json, text/event-stream" },
        redirect: "error",
        signal: this.lifecycle.signal,
      });
    } catch (error) {
      this.emit({
        event: "mcp.oauth_challenge_probe_failed",
        level: "debug",
        errorIdentity: describeErrorIdentity(error),
      });
      throw discoveryError;
    }

    const challengeError = await readAuthorizationChallenge(response);
    await response.body?.cancel().catch(() => undefined);
    if (challengeError === undefined) {
      this.emit({
        event: "mcp.oauth_challenge_probe_failed",
        level: "debug",
        status: response.status,
      });
      throw discoveryError;
    }
    this.emit({
      event: "mcp.oauth_challenge_probe_succeeded",
      level: "info",
      status: challengeError.status,
    });
    return challengeError.challenge;
  }

  private async recoverAuthorization(
    challenge: McpAuthorizationChallengeError,
    requestHadCredentials: boolean,
  ): Promise<AuthorizationRecovery> {
    if (this.recoveryPromise !== undefined) {
      return this.recoveryPromise;
    }

    const promise = this.recoverAuthorizationInternal(challenge, requestHadCredentials);
    this.recoveryPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.recoveryPromise === promise) {
        this.recoveryPromise = undefined;
      }
    }
  }

  private async recoverAuthorizationInternal(
    challenge: McpAuthorizationChallengeError,
    requestHadCredentials: boolean,
  ): Promise<AuthorizationRecovery> {
    const missingConfiguredScopes = this.findMissingConfiguredScopes(challenge.challenge);
    if (missingConfiguredScopes.length > 0) {
      this.emit({
        event: "mcp.oauth_scope_challenge_blocked",
        level: "warn",
        configuredScopeCount: this.options.scopes?.length ?? 0,
        challengedScopeCount: challenge.challenge.scopes?.length ?? 0,
        missingScopeCount: missingConfiguredScopes.length,
      });
      throw new McpAuthorizationChallengeError(
        challenge.status,
        challenge.kind,
        challenge.challenge,
        `MCP HTTP authorization requires scopes that are not included in the configured OAuth scopes: ${missingConfiguredScopes.join(" ")}.`,
      );
    }

    const session = await this.ensureSession(challenge.challenge);

    if (!requestHadCredentials) {
      const storedToken = await session.getAccessToken();
      if (storedToken !== undefined) {
        return { token: storedToken, recovery: "stored_token" };
      }
    } else if (challenge.kind === "authorization_required") {
      const refreshed = await session.refresh();
      if (refreshed !== undefined) {
        return { token: refreshed.accessToken, recovery: "refreshed_token" };
      }
    }

    const token = await session.authorize({ scopes: this.selectScopes(challenge.challenge) });
    return { token, recovery: "interactive_authorization" };
  }

  private findMissingConfiguredScopes(challenge: McpBearerChallenge): string[] {
    if (this.options.scopes === undefined || challenge.scopes === undefined) {
      return [];
    }
    const configured = new Set(this.options.scopes);
    return challenge.scopes.filter((scope) => !configured.has(scope));
  }

  private async ensureSession(challenge?: McpBearerChallenge): Promise<OAuthSession> {
    if (this.session !== undefined) {
      return this.session;
    }
    if (this.sessionPromise !== undefined) {
      return this.sessionPromise;
    }

    const promise = this.createSession(challenge);
    this.sessionPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.sessionPromise === promise) {
        this.sessionPromise = undefined;
      }
    }
  }

  private async createSession(challenge?: McpBearerChallenge): Promise<OAuthSession> {
    const protectedResource = await discoverMcpProtectedResource(this.resource, {
      ...(challenge === undefined ? {} : { challenge }),
      fetch: this.rawFetch,
      onDiagnostic: (event) => this.emit(event),
      signal: this.lifecycle.signal,
    });
    this.protectedResource = protectedResource;
    const issuer = protectedResource.authorizationServers[0];
    if (issuer === undefined) {
      throw new McpTransportError(
        "MCP protected resource metadata did not provide an authorization server.",
      );
    }
    const metadata = await discoverOAuthAuthorizationServer(issuer, {
      fetch: this.rawFetch,
      onDiagnostic: (event) => this.emit(event),
      signal: this.lifecycle.signal,
    });
    this.assertOpen();
    const session = new OAuthSession({
      storageKey: this.options.storageKey,
      metadata,
      client: this.options.client,
      tokenStore: this.options.tokenStore,
      openAuthorizationUrl: this.options.openAuthorizationUrl,
      ...(this.options.redirectUri === undefined ? {} : { redirectUri: this.options.redirectUri }),
      scopes: this.selectScopes(undefined, protectedResource),
      resource: protectedResource.resource,
      ...(this.options.additionalAuthorizationParameters === undefined
        ? {}
        : { additionalAuthorizationParameters: this.options.additionalAuthorizationParameters }),
      ...(this.options.callbackTimeoutMs === undefined
        ? {}
        : { callbackTimeoutMs: this.options.callbackTimeoutMs }),
      fetch: this.rawFetch,
      onDiagnostic: (event) => this.emit(event),
      signal: this.lifecycle.signal,
    });
    this.session = session;
    return session;
  }

  private selectScopes(
    challenge?: McpBearerChallenge,
    protectedResource = this.protectedResource,
  ): string[] {
    // Explicit host configuration is a permission boundary. Only use
    // challenge or resource metadata scopes when the host did not choose a
    // scope set, following MCP's generic-client fallback strategy.
    const selected =
      this.options.scopes ??
      (protectedResource === undefined
        ? undefined
        : selectMcpAuthorizationScopes(challenge, protectedResource));
    return [...new Set(selected ?? [])];
  }

  private createRequestTemplate(input: string | URL | Request, init?: RequestInit): Request {
    const request = new Request(input, init);
    if (new URL(request.url).toString() !== this.endpoint.toString()) {
      throw new McpTransportError(
        "MCP OAuth authorizer refused to send credentials to a different endpoint.",
      );
    }
    return request;
  }

  private createAttempt(request: Request, accessToken: string | undefined): Request {
    const attempt = request.clone();
    if (accessToken === undefined) {
      return attempt;
    }
    const headers = new Headers(attempt.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    return new Request(attempt, { headers });
  }

  private assertOpen(): void {
    if (this.closing || this.closed) {
      throw new McpTransportError("MCP OAuth authorizer is closing or closed.");
    }
  }

  private emit(event: McpOAuthHttpDiagnosticEvent): void {
    try {
      this.options.onDiagnostic?.(event);
    } catch {
      // Diagnostic consumers cannot alter authorization or request delivery.
    }
  }
}

async function readAuthorizationChallenge(
  response: Response,
): Promise<McpAuthorizationChallengeError | undefined> {
  try {
    return createMcpAuthorizationChallengeError(response);
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
}

function parseEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (error) {
    throw new McpTransportError("MCP OAuth endpoint must be an absolute URL.", { cause: error });
  }
  if (endpoint.protocol !== "https:") {
    throw new McpTransportError("MCP OAuth endpoint must use HTTPS.");
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new McpTransportError("MCP OAuth endpoint cannot contain credentials or a fragment.");
  }
  return endpoint;
}

function describeErrorIdentity(error: unknown): string {
  if (!(error instanceof Error)) {
    return `thrown_${typeof error}`;
  }
  const code = (error as Error & { code?: unknown }).code;
  const safeCode =
    (typeof code === "string" || typeof code === "number") &&
    /^[a-zA-Z0-9_.-]{1,64}$/.test(String(code))
      ? String(code)
      : undefined;
  return safeCode === undefined ? error.name || "Error" : `${error.name || "Error"}/${safeCode}`;
}

function createLinkedAbortController(signal: AbortSignal | undefined): {
  controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  if (signal?.aborted) {
    controller.abort(signal.reason);
    return { controller, dispose() {} };
  }
  if (signal === undefined) {
    return { controller, dispose() {} };
  }

  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    dispose: () => signal.removeEventListener("abort", onAbort),
  };
}
