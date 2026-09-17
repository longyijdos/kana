import {
  auth,
  discoverAuthorizationServerMetadata,
  type OAuthClientInformationContext,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import {
  type OAuthCallbackServer,
  type OAuthClientCredentials,
  type OAuthDiagnosticEvent,
  type OAuthFetch,
  type OAuthStoredToken,
  type OAuthTokenStore,
  startOAuthCallbackServer,
} from "@/oauth";
import {
  canonicalizeMcpResource,
  createMcpAuthorizationChallengeError,
  discoverMcpProtectedResource,
  McpAuthorizationChallengeError,
  type McpAuthorizationDiagnosticEvent,
  type McpBearerChallenge,
  type McpProtectedResourceMetadata,
} from "./authorization";
import { McpAuthorizationError } from "./errors";

export type McpOAuthClientRegistration = {
  issuer: string;
  resource: string;
  redirectUri: string;
  client: OAuthClientCredentials;
};

export type McpOAuthClientStore = {
  loadClient(key: string): Promise<McpOAuthClientRegistration | undefined>;
  saveClient(key: string, registration: McpOAuthClientRegistration): Promise<void>;
  deleteClient(key: string): Promise<void>;
};

export type McpOAuthHttpDiagnosticEvent =
  | OAuthDiagnosticEvent
  | McpAuthorizationDiagnosticEvent
  | { event: "mcp.oauth_preparation_started"; level: "info" }
  | {
      event: "mcp.oauth_preparation_succeeded";
      level: "info";
      interactiveAuthorization: boolean;
    }
  | { event: "mcp.oauth_preparation_failed"; level: "warn"; errorIdentity: string }
  | { event: "mcp.oauth_client_registered"; level: "info" }
  | {
      event: "mcp.oauth_request_retried";
      level: "info";
      recovery: "stored_token" | "refreshed_token" | "interactive_authorization";
    }
  | {
      event: "mcp.oauth_scope_challenge_blocked";
      level: "warn";
      configuredScopeCount: number;
      challengedScopeCount: number;
      missingScopeCount: number;
    };

export type McpOAuthHttpAuthorizerOptions = {
  resource: string;
  storageKey: string;
  client?: OAuthClientCredentials;
  clientStore?: McpOAuthClientStore;
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

// The SDK owns OAuth discovery, registration, PKCE, exchange, and refresh.
// Kana keeps the callback, credential binding, scope policy, and HTTP boundary
// so browser authorization finishes before MCP negotiation starts.
export class McpOAuthHttpAuthorizer {
  private readonly endpoint: URL;
  private readonly resource: string;
  private readonly rawFetch: OAuthFetch;
  private readonly lifecycle = new AbortController();
  private readonly signal: AbortSignal;
  private discovery?: OAuthDiscoveryState;
  private discoveryPromise?: Promise<void>;
  private clientInformation?: StoredOAuthClientInformation;
  private registration?: McpOAuthClientRegistration;
  private token?: OAuthStoredToken;
  private authorizationPromise?: Promise<void>;
  private preparationPromise?: Promise<void>;
  private callbackServer?: OAuthCallbackServer;
  private callbackPromise?: ReturnType<OAuthCallbackServer["waitForCallback"]>;
  private verifier?: string;
  private interactiveAuthorization = false;
  private authorizationScopes?: string[];
  private lastAccessToken?: string;
  private closing = false;
  private closed = false;

  constructor(private readonly options: McpOAuthHttpAuthorizerOptions) {
    this.endpoint = new URL(options.resource);
    this.resource = canonicalizeMcpResource(options.resource);
    this.rawFetch = options.fetch ?? globalThis.fetch;
    this.signal = AbortSignal.any([
      this.lifecycle.signal,
      ...(options.signal === undefined ? [] : [options.signal]),
    ]);
    if (!options.storageKey) {
      throw new Error("MCP OAuth storage key cannot be empty.");
    }
    if (options.client === undefined && options.clientStore === undefined) {
      throw new Error("MCP dynamic OAuth registration requires a client store.");
    }
  }

  private readonly provider = this.createProvider();

  private createProvider(): OAuthClientProvider {
    const authorizer = this;
    return {
      get redirectUrl() {
        return authorizer.redirectUri;
      },
      get clientMetadata() {
        return {
          client_name: "Kana",
          redirect_uris: [authorizer.redirectUri],
          token_endpoint_auth_method: "none",
          scope: authorizer.options.scopes?.join(" "),
        };
      },
      state: async () => {
        await this.ensureCallbackServer();
        return crypto.randomUUID();
      },
      clientInformation: (ctx) =>
        this.clientInformation?.issuer === ctx?.issuer ? this.clientInformation : undefined,
      saveClientInformation: async (information, ctx) => {
        this.assertOpen();
        const method =
          "token_endpoint_auth_method" in information
            ? information.token_endpoint_auth_method
            : undefined;
        if (
          method !== undefined &&
          method !== "none" &&
          method !== "client_secret_basic" &&
          method !== "client_secret_post"
        ) {
          throw new McpAuthorizationError(
            "MCP OAuth registration returned an unsupported client authentication method.",
          );
        }
        const registration: McpOAuthClientRegistration = {
          issuer: this.requireIssuer(ctx),
          resource: this.resource,
          redirectUri: this.redirectUri,
          client: {
            clientId: information.client_id,
            ...(information.client_secret === undefined
              ? {}
              : { clientSecret: information.client_secret }),
            ...(method === undefined ? {} : { tokenEndpointAuthMethod: method }),
          },
        };
        await this.options.clientStore!.saveClient(this.options.storageKey, registration);
        this.clientInformation = information;
        this.registration = registration;
        this.emit({ event: "mcp.oauth_client_registered", level: "info" });
      },
      tokens: (ctx) => {
        if (this.token === undefined || (ctx !== undefined && this.token.issuer !== ctx.issuer)) {
          return undefined;
        }
        return {
          access_token: this.token.accessToken,
          token_type: this.token.tokenType,
          issuer: this.token.issuer,
          ...(this.token.refreshToken === undefined
            ? {}
            : { refresh_token: this.token.refreshToken }),
          ...(this.token.expiresAt === undefined
            ? {}
            : { expires_in: Math.max(0, Math.floor((this.token.expiresAt - Date.now()) / 1_000)) }),
          ...(this.token.scopes === undefined ? {} : { scope: this.token.scopes.join(" ") }),
        };
      },
      saveTokens: (tokens, ctx) => this.saveTokens(tokens, ctx),
      redirectToAuthorization: async (url) => {
        this.assertScopes(url.searchParams.get("scope") ?? "");
        this.authorizationScopes = (url.searchParams.get("scope") ?? "")
          .split(/\s+/)
          .filter(Boolean);
        for (const [key, value] of Object.entries(
          this.options.additionalAuthorizationParameters ?? {},
        )) {
          url.searchParams.set(key, value);
        }
        this.interactiveAuthorization = true;
        this.emit({
          event: "oauth.authorization_started",
          level: "info",
          scopeCount: (url.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean).length,
        });
        this.callbackPromise = this.callbackServer!.waitForCallback(
          url.searchParams.get("state")!,
          { signal: this.signal },
        );
        void this.callbackPromise.catch(() => undefined);
        await this.options.openAuthorizationUrl(url.href);
      },
      saveCodeVerifier: (verifier) => {
        this.verifier = verifier;
      },
      codeVerifier: () => {
        if (this.verifier === undefined)
          throw new McpAuthorizationError("MCP OAuth has no pending PKCE verifier.");
        return this.verifier;
      },
      validateResourceURL: async (_url, resource) => {
        if (resource !== undefined && canonicalizeMcpResource(resource) !== this.resource) {
          throw new McpAuthorizationError(
            "MCP protected resource metadata does not match the configured resource.",
          );
        }
        return new URL(this.resource);
      },
      discoveryState: () => this.discovery,
      saveDiscoveryState: (state) => {
        this.discovery = state;
      },
      invalidateCredentials: async (scope) => {
        this.assertOpen();
        if (scope === "all" || scope === "tokens") {
          this.token = undefined;
          await this.options.tokenStore.delete(this.options.storageKey);
        }
        if (scope === "all" || scope === "client") {
          this.clientInformation = undefined;
          this.registration = undefined;
          await this.options.clientStore?.deleteClient(this.options.storageKey);
          if (this.options.client !== undefined)
            this.clientInformation = this.registeredClient(this.options.client);
          else await this.ensureCallbackServer();
        }
        if (scope === "all" || scope === "verifier") this.verifier = undefined;
        if (scope === "all" || scope === "discovery") this.discovery = undefined;
      },
    };
  }

  readonly fetch: OAuthFetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).href !== this.endpoint.href) {
      throw new McpAuthorizationError(
        "MCP OAuth authorizer refused to send credentials to a different endpoint.",
      );
    }
    const deleting = request.method === "DELETE";
    if (this.closed) throw new McpAuthorizationError("MCP OAuth authorizer is closed.");
    if (!deleting) this.assertOpen();
    let accessToken = this.closing ? this.lastAccessToken : await this.getAccessToken();
    if (accessToken !== undefined) this.lastAccessToken = accessToken;
    const attempt = () => {
      const headers = new Headers(request.headers);
      if (accessToken !== undefined) headers.set("Authorization", `Bearer ${accessToken}`);
      return new Request(request.clone(), {
        headers,
        signal: deleting ? request.signal : AbortSignal.any([request.signal, this.signal]),
      });
    };
    const response = await this.rawFetch(attempt());
    const challenge = createMcpAuthorizationChallengeError(response);
    if (challenge === undefined || deleting) return response;
    await response.body?.cancel();
    this.assertScopes(challenge.challenge.scopes?.join(" ") ?? "", challenge);
    const previous = this.token?.accessToken;
    await this.authenticate(challenge.kind === "insufficient_scope", challenge.challenge);
    accessToken = this.token?.accessToken;
    this.lastAccessToken = accessToken;
    this.emit({
      event: "mcp.oauth_request_retried",
      level: "info",
      recovery: this.interactiveAuthorization
        ? "interactive_authorization"
        : previous === this.lastAccessToken
          ? "stored_token"
          : "refreshed_token",
    });
    return this.rawFetch(attempt());
  };

  prepare(): Promise<void> {
    this.assertOpen();
    this.preparationPromise ??= this.prepareInternal();
    return this.preparationPromise;
  }

  authorize(): Promise<void> {
    this.assertOpen();
    return this.authenticate(true);
  }

  beginClose(): void {
    if (this.closing) return;
    this.closing = true;
    this.lifecycle.abort(new McpAuthorizationError("MCP OAuth authorizer is closing."));
  }

  close(): void {
    this.beginClose();
    this.closed = true;
    this.lastAccessToken = undefined;
    this.token = undefined;
    this.clientInformation = undefined;
    this.registration = undefined;
  }

  private get redirectUri(): string {
    return (
      this.callbackServer?.redirectUri ??
      this.options.redirectUri ??
      this.registration?.redirectUri ??
      "http://127.0.0.1:0/oauth/callback"
    );
  }

  private async prepareInternal(): Promise<void> {
    this.emit({ event: "mcp.oauth_preparation_started", level: "info" });
    try {
      if ((await this.getAccessToken()) === undefined) await this.authenticate(false);
      this.lastAccessToken = this.token?.accessToken;
      this.emit({
        event: "mcp.oauth_preparation_succeeded",
        level: "info",
        interactiveAuthorization: this.interactiveAuthorization,
      });
    } catch (error) {
      if (!this.signal.aborted)
        this.emit({
          event: "mcp.oauth_preparation_failed",
          level: "warn",
          errorIdentity: error instanceof Error ? error.name : "Error",
        });
      throw error;
    }
  }

  private async getAccessToken(): Promise<string | undefined> {
    await this.ensureDiscovery();
    if (this.token === undefined) return undefined;
    if (this.token.expiresAt !== undefined && this.token.expiresAt <= Date.now() + 60_000) {
      if (this.token.refreshToken === undefined) return undefined;
      await this.authenticate(false);
    }
    return this.token?.accessToken;
  }

  private ensureDiscovery(challenge?: McpBearerChallenge): Promise<void> {
    this.assertOpen();
    if (this.discoveryPromise !== undefined) return this.discoveryPromise;
    if (this.discovery !== undefined) return Promise.resolve();
    this.discoveryPromise ??= this.discover(challenge).finally(() => {
      this.discoveryPromise = undefined;
    });
    return this.discoveryPromise;
  }

  private async discover(challenge?: McpBearerChallenge): Promise<void> {
    let protectedResource: McpProtectedResourceMetadata;
    try {
      protectedResource = await discoverMcpProtectedResource(this.resource, {
        challenge,
        fetch: this.sdkFetch,
        signal: this.signal,
        onDiagnostic: (event) => this.emit(event),
      });
    } catch (error) {
      if (challenge !== undefined || this.signal.aborted) throw error;
      const response = await this.sdkFetch(this.endpoint, {
        method: "HEAD",
        headers: { Accept: "application/json, text/event-stream" },
      });
      const probe = createMcpAuthorizationChallengeError(response);
      await response.body?.cancel();
      if (probe === undefined) throw error;
      protectedResource = await discoverMcpProtectedResource(this.resource, {
        challenge: probe.challenge,
        fetch: this.sdkFetch,
        signal: this.signal,
        onDiagnostic: (event) => this.emit(event),
      });
    }
    const issuer = protectedResource.authorizationServers[0]!;
    const metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn: this.sdkFetch });
    if (metadata === undefined)
      throw new McpAuthorizationError("MCP OAuth authorization-server metadata is unavailable.");
    this.assertOpen();
    this.registration = await this.options.clientStore?.loadClient(this.options.storageKey);
    if (
      this.registration !== undefined &&
      (this.registration.issuer !== metadata.issuer ||
        this.registration.resource !== this.resource ||
        (this.options.redirectUri !== undefined &&
          this.registration.redirectUri !== this.options.redirectUri))
    ) {
      this.registration = undefined;
      await this.options.clientStore!.deleteClient(this.options.storageKey);
    }
    this.discovery = {
      authorizationServerUrl: issuer,
      authorizationServerMetadata: metadata,
      resourceMetadata: {
        resource: protectedResource.resource,
        authorization_servers: protectedResource.authorizationServers,
        scopes_supported: this.options.scopes?.slice() ?? protectedResource.scopesSupported,
      },
    };
    const client = this.options.client ?? this.registration?.client;
    if (client !== undefined) this.clientInformation = this.registeredClient(client);
    this.token = await this.options.tokenStore.load(this.options.storageKey);
    if (
      this.token !== undefined &&
      (this.token.issuer !== metadata.issuer ||
        this.token.resource !== this.resource ||
        this.token.clientId !== client?.clientId)
    ) {
      this.token = undefined;
      await this.options.tokenStore.delete(this.options.storageKey);
    }
  }

  private readonly sdkFetch: OAuthFetch = (input, init) => {
    this.assertOpen();
    return this.rawFetch(input, {
      ...init,
      signal: AbortSignal.any([this.signal, ...(init?.signal ? [init.signal] : [])]),
    });
  };

  private registeredClient(client: OAuthClientCredentials): StoredOAuthClientInformation {
    return {
      client_id: client.clientId,
      issuer: this.discovery!.authorizationServerMetadata!.issuer,
      ...(client.clientSecret === undefined ? {} : { client_secret: client.clientSecret }),
      ...(client.tokenEndpointAuthMethod === undefined
        ? {}
        : { token_endpoint_auth_method: client.tokenEndpointAuthMethod }),
    };
  }

  private authenticate(
    forceReauthorization: boolean,
    challenge?: McpBearerChallenge,
  ): Promise<void> {
    this.assertOpen();
    this.authorizationPromise ??= this.runAuthorization(forceReauthorization, challenge).finally(
      () => {
        this.authorizationPromise = undefined;
      },
    );
    return this.authorizationPromise;
  }

  private async runAuthorization(
    forceReauthorization: boolean,
    challenge?: McpBearerChallenge,
  ): Promise<void> {
    try {
      await this.ensureDiscovery(challenge);
      if (this.clientInformation === undefined) await this.ensureCallbackServer();
      this.interactiveAuthorization = false;
      const scope = this.options.scopes?.join(" ") ?? challenge?.scopes?.join(" ");
      const result = await auth(this.provider, {
        serverUrl: this.resource,
        scope,
        forceReauthorization,
        fetchFn: this.sdkFetch,
      });
      if (result === "REDIRECT") {
        const callback = await this.callbackPromise!;
        this.emit({ event: "oauth.authorization_callback_received", level: "debug" });
        await auth(this.provider, {
          serverUrl: this.resource,
          authorizationCode: callback.code,
          iss: callback.iss,
          scope,
          fetchFn: this.sdkFetch,
        });
        this.emit({
          event: "oauth.authorization_succeeded",
          level: "info",
          scopeCount: this.token?.scopes?.length ?? 0,
          refreshTokenAvailable: this.token?.refreshToken !== undefined,
        });
      }
    } catch (error) {
      if (!this.signal.aborted)
        this.emit({
          event: "oauth.authorization_failed",
          level: "warn",
          errorIdentity: error instanceof Error ? error.name : "Error",
        });
      throw error;
    } finally {
      await this.callbackServer?.close();
      this.callbackServer = undefined;
      this.callbackPromise = undefined;
      this.verifier = undefined;
    }
  }

  private async ensureCallbackServer(): Promise<void> {
    if (this.callbackServer !== undefined) return;
    this.callbackServer = await startOAuthCallbackServer({
      redirectUri: this.options.redirectUri ?? this.registration?.redirectUri,
      timeoutMs: this.options.callbackTimeoutMs,
    });
    this.assertOpen();
  }

  private async saveTokens(
    tokens: StoredOAuthTokens,
    ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    this.assertOpen();
    const scopes =
      tokens.scope?.split(/\s+/).filter(Boolean) ??
      (this.interactiveAuthorization ? this.authorizationScopes : this.token?.scopes);
    const token: OAuthStoredToken = {
      accessToken: tokens.access_token,
      tokenType: "Bearer",
      issuer: this.requireIssuer(ctx),
      clientId: this.clientInformation!.client_id,
      resource: this.resource,
      ...((tokens.refresh_token ?? this.token?.refreshToken)
        ? { refreshToken: tokens.refresh_token ?? this.token?.refreshToken }
        : {}),
      ...(tokens.expires_in === undefined
        ? {}
        : { expiresAt: Date.now() + tokens.expires_in * 1_000 }),
      ...(scopes === undefined ? {} : { scopes: scopes.slice() }),
    };
    await this.options.tokenStore.save(this.options.storageKey, token);
    this.token = token;
    this.lastAccessToken = token.accessToken;
  }

  private requireIssuer(ctx?: OAuthClientInformationContext): string {
    return ctx?.issuer ?? this.discovery!.authorizationServerMetadata!.issuer;
  }

  private assertScopes(scope: string, challenge?: McpAuthorizationChallengeError): void {
    if (this.options.scopes === undefined) return;
    const scopes = scope.split(/\s+/).filter(Boolean);
    const missing = scopes.filter((value) => !this.options.scopes!.includes(value));
    if (missing.length === 0) return;
    this.emit({
      event: "mcp.oauth_scope_challenge_blocked",
      level: "warn",
      configuredScopeCount: this.options.scopes.length,
      challengedScopeCount: scopes.length,
      missingScopeCount: missing.length,
    });
    const message = `MCP HTTP authorization requires scopes that are not included in the configured OAuth scopes: ${missing.join(" ")}.`;
    if (challenge !== undefined)
      throw new McpAuthorizationChallengeError(
        challenge.status,
        challenge.kind,
        challenge.challenge,
        message,
      );
    throw new McpAuthorizationError(message);
  }

  private assertOpen(): void {
    this.signal.throwIfAborted();
  }

  private emit(event: McpOAuthHttpDiagnosticEvent): void {
    try {
      this.options.onDiagnostic?.(event);
    } catch {
      // Diagnostics cannot change authorization control flow.
    }
  }
}
