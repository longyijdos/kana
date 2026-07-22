import {
  type OAuthCallbackServer,
  type StartOAuthCallbackServerOptions,
  startOAuthCallbackServer,
} from "./callback-server";
import {
  createOAuthAuthorizationRequest,
  exchangeOAuthAuthorizationCode,
  refreshOAuthAccessToken,
} from "./client";
import { OAuthAuthorizationResponseError, OAuthError, OAuthTokenEndpointError } from "./errors";
import { describeOAuthErrorIdentity } from "./http";
import type {
  OAuthAuthorizationServerMetadata,
  OAuthClientCredentials,
  OAuthDiagnosticEvent,
  OAuthDiagnosticHandler,
  OAuthFetch,
  OAuthStoredToken,
  OAuthTokenSet,
  OAuthTokenStore,
} from "./types";

const DEFAULT_REFRESH_SKEW_MS = 60_000;

export type OAuthSessionStatus = {
  state: "unauthorized" | "authorized" | "expired";
  refreshable: boolean;
  expiresAt?: number;
  scopes?: string[];
};

export type OAuthSessionOptions = {
  storageKey: string;
  metadata: OAuthAuthorizationServerMetadata;
  client: OAuthClientCredentials;
  redirectUri?: string;
  tokenStore: OAuthTokenStore;
  openAuthorizationUrl(url: string): Promise<void>;
  scopes?: readonly string[];
  resource?: string;
  additionalAuthorizationParameters?: Readonly<Record<string, string>>;
  callbackTimeoutMs?: number;
  refreshSkewMs?: number;
  fetch?: OAuthFetch;
  onDiagnostic?: OAuthDiagnosticHandler;
  signal?: AbortSignal;
  now?: () => number;
  startCallbackServer?(options: StartOAuthCallbackServerOptions): Promise<OAuthCallbackServer>;
};

export type OAuthAuthorizeOptions = {
  scopes?: readonly string[];
};

// OAuthSession owns the mutable token boundary for one client/resource binding.
// Protocol requests remain stateless functions, while refresh and interactive
// authorization are coalesced here so concurrent consumers cannot rotate or
// overwrite the same refresh token independently.
export class OAuthSession {
  private token?: OAuthStoredToken;
  private tokenLoaded = false;
  private loadPromise?: Promise<OAuthStoredToken | undefined>;
  private refreshPromise?: Promise<OAuthStoredToken | undefined>;
  private authorization?: { scopesKey: string; promise: Promise<OAuthStoredToken> };
  private authorizationController?: AbortController;
  private refreshController?: AbortController;
  private readonly lifecycle: LinkedAbortController;
  private storeMutation: Promise<void> = Promise.resolve();
  private revision = 0;
  private closed = false;

  constructor(private readonly options: OAuthSessionOptions) {
    if (!options.storageKey) {
      throw new Error("OAuth session storageKey cannot be empty.");
    }
    assertNonNegativeInteger(options.refreshSkewMs, "refreshSkewMs");
    this.lifecycle = createLinkedAbortController(options.signal);
  }

  async getAccessToken(): Promise<string | undefined> {
    this.assertOpen();
    const token = await this.loadToken();
    if (token === undefined) {
      return undefined;
    }
    if (this.isUsable(token)) {
      return token.accessToken;
    }
    return (await this.refresh())?.accessToken;
  }

  async getStatus(): Promise<OAuthSessionStatus> {
    this.assertOpen();
    const token = await this.loadToken();
    if (token === undefined) {
      return { state: "unauthorized", refreshable: false };
    }
    return {
      state: this.isUsable(token) ? "authorized" : "expired",
      refreshable: token.refreshToken !== undefined,
      ...(token.expiresAt === undefined ? {} : { expiresAt: token.expiresAt }),
      ...(token.scopes === undefined ? {} : { scopes: token.scopes.slice() }),
    };
  }

  async authorize(options: OAuthAuthorizeOptions = {}): Promise<string> {
    this.assertOpen();
    const scopes = [...(options.scopes ?? this.options.scopes ?? [])];
    const scopesKey = [...scopes].sort().join("\n");
    if (this.authorization !== undefined) {
      if (this.authorization.scopesKey !== scopesKey) {
        throw new OAuthError("OAuth authorization with different scopes is already in progress.");
      }
      return (await this.authorization.promise).accessToken;
    }

    const promise = this.runAuthorization(scopes);
    this.authorization = { scopesKey, promise };
    try {
      return (await promise).accessToken;
    } finally {
      if (this.authorization?.promise === promise) {
        this.authorization = undefined;
      }
    }
  }

  async refresh(): Promise<OAuthStoredToken | undefined> {
    this.assertOpen();
    if (this.refreshPromise !== undefined) {
      return this.refreshPromise;
    }
    const promise = this.runRefresh();
    this.refreshPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.refreshPromise === promise) {
        this.refreshPromise = undefined;
      }
    }
  }

  async signOut(): Promise<void> {
    this.assertOpen();
    this.revision += 1;
    this.authorizationController?.abort(new OAuthError("OAuth authorization was cancelled."));
    this.refreshController?.abort(new OAuthError("OAuth token refresh was cancelled."));
    this.token = undefined;
    this.tokenLoaded = true;
    this.loadPromise = undefined;
    await this.mutateStore(() => this.options.tokenStore.delete(this.options.storageKey));
    this.emit({
      event: "oauth.token_invalidated",
      level: "info",
      reason: "signed_out",
    });
  }

  cancelPending(reason: unknown = new OAuthError("OAuth operation was cancelled.")): void {
    this.assertOpen();
    this.authorizationController?.abort(reason);
    this.refreshController?.abort(reason);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.revision += 1;
    this.authorizationController?.abort(new OAuthError("OAuth session closed."));
    this.refreshController?.abort(new OAuthError("OAuth session closed."));
    this.lifecycle.controller.abort(new OAuthError("OAuth session closed."));
    this.lifecycle.dispose();
  }

  private async runAuthorization(scopes: string[]): Promise<OAuthStoredToken> {
    const revision = this.revision;
    const linked = createLinkedAbortController(this.lifecycle.controller.signal);
    const controller = linked.controller;
    this.authorizationController = controller;
    let callbackServer: OAuthCallbackServer | undefined;

    this.emit({
      event: "oauth.authorization_started",
      level: "info",
      scopeCount: scopes.length,
    });

    try {
      callbackServer = await (this.options.startCallbackServer ?? startOAuthCallbackServer)({
        ...(this.options.redirectUri === undefined
          ? {}
          : { redirectUri: this.options.redirectUri }),
        ...(this.options.callbackTimeoutMs === undefined
          ? {}
          : { timeoutMs: this.options.callbackTimeoutMs }),
      });
      const request = createOAuthAuthorizationRequest({
        metadata: this.options.metadata,
        client: this.options.client,
        redirectUri: callbackServer.redirectUri,
        scopes,
        ...(this.options.resource === undefined ? {} : { resource: this.options.resource }),
        ...(this.options.additionalAuthorizationParameters === undefined
          ? {}
          : { additionalParameters: this.options.additionalAuthorizationParameters }),
      });
      const callbackPromise = callbackServer.waitForCallback(request.state, {
        signal: controller.signal,
      });
      try {
        await this.options.openAuthorizationUrl(request.authorizationUrl);
      } catch (error) {
        void callbackPromise.catch(() => undefined);
        throw error;
      }
      const callback = await callbackPromise;
      this.emit({ event: "oauth.authorization_callback_received", level: "debug" });

      const exchanged = await exchangeOAuthAuthorizationCode({
        metadata: this.options.metadata,
        client: this.options.client,
        code: callback.code,
        codeVerifier: request.codeVerifier,
        redirectUri: callbackServer.redirectUri,
        ...(this.options.resource === undefined ? {} : { resource: this.options.resource }),
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
        ...(this.options.onDiagnostic === undefined
          ? {}
          : { onDiagnostic: this.options.onDiagnostic }),
        signal: controller.signal,
        now: this.now,
      });
      const previous = await this.loadToken();
      const stored = this.bindToken(exchanged, {
        refreshToken: exchanged.refreshToken ?? previous?.refreshToken,
        scopes: exchanged.scopes ?? scopes,
      });
      await this.saveToken(stored, revision);
      this.emit({
        event: "oauth.authorization_succeeded",
        level: "info",
        scopeCount: stored.scopes?.length ?? 0,
        refreshTokenAvailable: stored.refreshToken !== undefined,
      });
      return stored;
    } catch (error) {
      if (!controller.signal.aborted) {
        this.emit({
          event: "oauth.authorization_failed",
          level: "warn",
          ...(error instanceof OAuthAuthorizationResponseError
            ? { oauthError: error.oauthError }
            : { errorIdentity: describeOAuthErrorIdentity(error) }),
        });
      }
      throw error;
    } finally {
      if (this.authorizationController === controller) {
        this.authorizationController = undefined;
      }
      linked.dispose();
      await callbackServer?.close().catch(() => undefined);
    }
  }

  private async runRefresh(): Promise<OAuthStoredToken | undefined> {
    const current = await this.loadToken();
    if (current?.refreshToken === undefined) {
      return undefined;
    }
    const revision = this.revision;
    const linked = createLinkedAbortController(this.lifecycle.controller.signal);
    const controller = linked.controller;
    this.refreshController = controller;

    try {
      const refreshed = await refreshOAuthAccessToken({
        metadata: this.options.metadata,
        client: this.options.client,
        refreshToken: current.refreshToken,
        ...(this.options.resource === undefined ? {} : { resource: this.options.resource }),
        ...(current.scopes === undefined ? {} : { scopes: current.scopes }),
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
        ...(this.options.onDiagnostic === undefined
          ? {}
          : { onDiagnostic: this.options.onDiagnostic }),
        signal: controller.signal,
        now: this.now,
      });
      const stored = this.bindToken(refreshed, {
        refreshToken: refreshed.refreshToken ?? current.refreshToken,
        scopes: refreshed.scopes ?? current.scopes,
      });
      await this.saveToken(stored, revision);
      return stored;
    } catch (error) {
      if (error instanceof OAuthTokenEndpointError && error.oauthError === "invalid_grant") {
        await this.invalidateRefreshToken(revision);
        return undefined;
      }
      throw error;
    } finally {
      if (this.refreshController === controller) {
        this.refreshController = undefined;
      }
      linked.dispose();
    }
  }

  private async loadToken(): Promise<OAuthStoredToken | undefined> {
    if (this.tokenLoaded) {
      return this.token;
    }
    if (this.loadPromise !== undefined) {
      return this.loadPromise;
    }

    const revision = this.revision;
    const promise = this.options.tokenStore.load(this.options.storageKey).then(async (token) => {
      if (revision !== this.revision) {
        return this.token;
      }
      if (token !== undefined && !this.matchesBinding(token)) {
        await this.mutateStore(() => this.options.tokenStore.delete(this.options.storageKey));
        if (revision !== this.revision) {
          return this.token;
        }
        this.emit({
          event: "oauth.token_invalidated",
          level: "info",
          reason: "binding_changed",
        });
        token = undefined;
      }
      this.token = token === undefined ? undefined : copyStoredToken(token);
      this.tokenLoaded = true;
      return this.token;
    });
    this.loadPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.loadPromise === promise) {
        this.loadPromise = undefined;
      }
    }
  }

  private async saveToken(token: OAuthStoredToken, revision: number): Promise<void> {
    const saved = await this.mutateStore(async () => {
      if (revision !== this.revision) {
        return false;
      }
      await this.options.tokenStore.save(this.options.storageKey, copyStoredToken(token));
      if (revision !== this.revision) {
        await this.options.tokenStore.delete(this.options.storageKey);
        return false;
      }
      return true;
    });
    if (!saved || revision !== this.revision) {
      throw new OAuthError("OAuth session changed while credentials were being saved.");
    }
    this.token = copyStoredToken(token);
    this.tokenLoaded = true;
  }

  private async invalidateRefreshToken(revision: number): Promise<void> {
    if (revision !== this.revision) {
      return;
    }
    this.revision += 1;
    this.token = undefined;
    this.tokenLoaded = true;
    await this.mutateStore(() => this.options.tokenStore.delete(this.options.storageKey));
    this.emit({
      event: "oauth.token_invalidated",
      level: "info",
      reason: "refresh_rejected",
    });
  }

  private bindToken(
    token: OAuthTokenSet,
    fallback: { refreshToken?: string; scopes?: string[] },
  ): OAuthStoredToken {
    return {
      ...token,
      issuer: this.options.metadata.issuer,
      clientId: this.options.client.clientId,
      ...(this.options.resource === undefined ? {} : { resource: this.options.resource }),
      ...(fallback.refreshToken === undefined ? {} : { refreshToken: fallback.refreshToken }),
      ...(fallback.scopes === undefined ? {} : { scopes: fallback.scopes.slice() }),
    };
  }

  private matchesBinding(token: OAuthStoredToken): boolean {
    return (
      token.issuer === this.options.metadata.issuer &&
      token.clientId === this.options.client.clientId &&
      token.resource === this.options.resource
    );
  }

  private isUsable(token: OAuthStoredToken): boolean {
    return (
      token.expiresAt === undefined ||
      token.expiresAt > this.now() + (this.options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS)
    );
  }

  private readonly now = (): number => this.options.now?.() ?? Date.now();

  private mutateStore<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.storeMutation.then(operation, operation);
    this.storeMutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new OAuthError("OAuth session is closed.");
    }
  }

  private emit(event: OAuthDiagnosticEvent): void {
    try {
      this.options.onDiagnostic?.(event);
    } catch {
      // Diagnostic consumers cannot alter authorization or token state.
    }
  }
}

function copyStoredToken(token: OAuthStoredToken): OAuthStoredToken {
  return {
    ...token,
    ...(token.scopes === undefined ? {} : { scopes: token.scopes.slice() }),
  };
}

type LinkedAbortController = {
  controller: AbortController;
  dispose(): void;
};

function createLinkedAbortController(signal: AbortSignal | undefined): LinkedAbortController {
  const controller = new AbortController();
  let dispose = () => {};
  if (signal?.aborted) {
    controller.abort(signal.reason);
  } else if (signal !== undefined) {
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    dispose = () => signal.removeEventListener("abort", onAbort);
  }
  return { controller, dispose };
}

function assertNonNegativeInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}
