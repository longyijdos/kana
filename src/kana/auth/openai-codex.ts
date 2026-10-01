import { setTimeout } from "node:timers/promises";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { createNoopLogger, type Logger } from "@/logging";
import {
  createOAuthAuthorizationRequest,
  exchangeOAuthAuthorizationCode,
  type OAuthAuthorizationServerMetadata,
  type OAuthCallbackServer,
  type OAuthDiagnosticEvent,
  type OAuthFetch,
  type OAuthSessionStatus,
  type OAuthStoredToken,
  OAuthTokenEndpointError,
  refreshOAuthAccessToken,
  startOAuthCallbackServer,
} from "@/oauth";
import type { OpenAICodexCredentialProvider, OpenAICodexCredentials } from "@/providers";
import { openKanaOAuthAuthorizationUrl } from "./browser";
import {
  createKanaOAuthTokenStore,
  type KanaOpenAICodexAuthState,
  type KanaOpenAICodexAuthStore,
} from "./token-store";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const STORAGE_KEY = "provider:openai-codex";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", DIRECT_SCOPE];
const METADATA: OAuthAuthorizationServerMetadata = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/api/accounts/authorize`,
  tokenEndpoint: `${ISSUER}/api/accounts/oauth/token`,
  codeChallengeMethodsSupported: ["S256"],
  tokenEndpointAuthMethodsSupported: ["none"],
};
const REJECTED_REFRESH_ERRORS = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export type CreateKanaOpenAICodexAuthOptions = {
  env?: NodeJS.ProcessEnv;
  getLogger?: () => Logger;
  tokenStore?: KanaOpenAICodexAuthStore;
  openAuthorizationUrl?(url: string): Promise<void>;
  fetch?: OAuthFetch;
  signal?: AbortSignal;
  startCallbackServer?(options: { redirectUri: string }): Promise<OAuthCallbackServer>;
};

export type KanaOpenAICodexAuthStatus = OAuthSessionStatus & {
  planUsage?: boolean;
  email?: string;
};

export class KanaOpenAICodexAuth implements OpenAICodexCredentialProvider {
  private readonly store: KanaOpenAICodexAuthStore;
  private readonly fetch: OAuthFetch;
  private readonly getLogger: () => Logger;
  private readonly lifecycle = new AbortController();
  private readonly signal: AbortSignal;
  private readonly jwks;
  private authorization?: Promise<OpenAICodexCredentials | undefined>;
  private refreshPromise?: Promise<OAuthStoredToken | undefined>;
  private authorizationController?: AbortController;
  private refreshController?: AbortController;
  private revision = 0;
  private closed = false;

  constructor(private readonly options: CreateKanaOpenAICodexAuthOptions = {}) {
    this.getLogger = options.getLogger ?? createNoopLogger;
    this.store = options.tokenStore ?? createKanaOAuthTokenStore(options);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.signal = options.signal
      ? AbortSignal.any([options.signal, this.lifecycle.signal])
      : this.lifecycle.signal;
    this.jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`), {
      [customFetch]: (url, init) =>
        this.fetch(url, {
          ...init,
          signal: AbortSignal.any([this.signal, ...(init.signal ? [init.signal] : [])]),
        }),
    });
  }

  async authorize(): Promise<OpenAICodexCredentials | undefined> {
    this.assertOpen();
    if (this.authorization) return this.authorization;
    const promise = this.runAuthorization();
    this.authorization = promise;
    try {
      return await promise;
    } finally {
      if (this.authorization === promise) this.authorization = undefined;
    }
  }

  async getCredentials(): Promise<OpenAICodexCredentials | undefined> {
    this.assertOpen();
    const token = await this.loadToken();
    const current = token && isUsable(token) ? token : await this.refreshToken();
    return current === undefined ? undefined : credentialsFromToken(current);
  }

  async refreshCredentials(): Promise<OpenAICodexCredentials | undefined> {
    this.assertOpen();
    const token = await this.refreshToken(true);
    return token === undefined ? undefined : credentialsFromToken(token);
  }

  async getStatus(): Promise<KanaOpenAICodexAuthStatus> {
    this.assertOpen();
    const state = await this.store.loadOpenAICodexState();
    const token = await this.loadToken();
    return {
      state: token === undefined ? "unauthorized" : isUsable(token) ? "authorized" : "expired",
      refreshable: token?.refreshToken !== undefined,
      ...(token === undefined ? {} : { planUsage: token.scopes?.includes(DIRECT_SCOPE) === true }),
      ...(token?.expiresAt === undefined ? {} : { expiresAt: token.expiresAt }),
      ...(token?.scopes === undefined ? {} : { scopes: token.scopes.slice() }),
      ...(state?.registration?.email === undefined ? {} : { email: state.registration.email }),
    };
  }

  async signOut(): Promise<void> {
    this.assertOpen();
    this.revision += 1;
    this.authorizationController?.abort(new Error("OpenAI Codex sign-in was cancelled."));
    this.refreshController?.abort(new Error("OpenAI Codex token refresh was cancelled."));
    await this.store.withOpenAICodexLock(async () => {
      const token = await this.loadToken();
      let revoked = true;
      try {
        if (token?.refreshToken) revoked = await this.revokeSession(token);
      } finally {
        await this.store.delete(STORAGE_KEY);
        this.log("openai_codex_auth.signed_out", "info", { remoteRevocationConfirmed: revoked });
      }
      if (!revoked) {
        throw new Error(
          "Signed out locally; remote revocation was not confirmed. Disconnect kana in ChatGPT settings.",
        );
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.revision += 1;
    this.lifecycle.abort(new Error("OpenAI Codex authentication closed."));
  }

  private async runAuthorization(): Promise<OpenAICodexCredentials | undefined> {
    const revision = this.revision;
    const controller = new AbortController();
    this.authorizationController = controller;
    const signal = AbortSignal.any([this.signal, controller.signal]);
    let listener: OAuthCallbackServer | undefined;
    this.log("oauth.authorization_started", "info", { scopeCount: SCOPES.length });
    try {
      const state = await this.store.withOpenAICodexLock(async () => {
        const saved: KanaOpenAICodexAuthState = (await this.store.loadOpenAICodexState()) ?? {
          hostId: `urn:uuid:${crypto.randomUUID()}`,
        };
        await this.store.saveOpenAICodexState(saved);
        return saved;
      });
      const clientId = state.registration?.clientId ?? state.pendingClientId;
      const previous = await this.loadToken();
      const nonce = crypto.randomUUID();
      const additionalParameters: Record<string, string> = {
        ext_agent_host_id: state.hostId,
        nonce,
      };
      if (clientId === undefined) additionalParameters.agent_name_hint = "kana";
      if (previous?.idToken) {
        additionalParameters.id_token_hint = previous.idToken;
        if (state.registration?.email) additionalParameters.login_hint = state.registration.email;
        if (!previous.scopes?.includes(DIRECT_SCOPE)) additionalParameters.prompt = "consent";
      }
      listener = await (this.options.startCallbackServer ?? startOAuthCallbackServer)({
        redirectUri: "http://127.0.0.1:1455/auth/callback",
      });
      const request = createOAuthAuthorizationRequest({
        metadata: METADATA,
        client: { clientId: clientId ?? DYNAMIC_CLIENT_ID, tokenEndpointAuthMethod: "none" },
        redirectUri: listener.redirectUri,
        scopes: SCOPES,
        resource: RESOURCE,
        additionalParameters,
      });
      const callbackPromise = listener.waitForCallback(request.state, { signal });
      try {
        await (
          this.options.openAuthorizationUrl ??
          ((url) => openKanaOAuthAuthorizationUrl(url, { getLogger: this.getLogger }))
        )(request.authorizationUrl);
      } catch (error) {
        void callbackPromise.catch(() => undefined);
        throw error;
      }
      const callback = await callbackPromise;
      const issuedClientId = callback.clientId ?? clientId;
      if (!issuedClientId || issuedClientId === DYNAMIC_CLIENT_ID) {
        throw new Error("ChatGPT registration did not return an issued client ID.");
      }
      if (clientId && issuedClientId !== clientId) {
        throw new Error("ChatGPT sign-in returned a different client registration.");
      }
      if (callback.iss !== undefined && callback.iss !== ISSUER) {
        throw new Error("ChatGPT sign-in returned a different issuer.");
      }
      if (clientId === undefined) {
        await this.store.withOpenAICodexLock(async () => {
          this.assertCurrent(revision, signal);
          const current = (await this.store.loadOpenAICodexState())!;
          await this.store.saveOpenAICodexState({ ...current, pendingClientId: issuedClientId });
        });
      }
      const exchanged = await exchangeOAuthAuthorizationCode({
        metadata: METADATA,
        client: { clientId: issuedClientId, tokenEndpointAuthMethod: "none" },
        code: callback.code,
        codeVerifier: request.codeVerifier,
        redirectUri: listener.redirectUri,
        resource: RESOURCE,
        fetch: this.fetch,
        signal,
        onDiagnostic: this.onDiagnostic,
      });
      if (!exchanged.idToken) throw new Error("ChatGPT sign-in did not return an ID token.");
      const { payload } = await jwtVerify(exchanged.idToken, this.jwks, {
        issuer: ISSUER,
        audience: issuedClientId,
        requiredClaims: ["sub", "exp", "iat", "nonce"],
        clockTolerance: 5,
      });
      if (payload.nonce !== nonce || typeof payload.sub !== "string" || !payload.sub) {
        throw new Error("ChatGPT sign-in identity or nonce did not match.");
      }
      if (state.registration?.subject !== undefined && payload.sub !== state.registration.subject) {
        throw new Error("ChatGPT sign-in returned a different account.");
      }
      const subject = payload.sub;
      const token: OAuthStoredToken = {
        ...exchanged,
        scopes: exchanged.scopes ?? [],
        issuer: ISSUER,
        clientId: issuedClientId,
        resource: RESOURCE,
      };
      await this.store.withOpenAICodexLock(async () => {
        this.assertCurrent(revision, signal);
        await this.store.saveOpenAICodexState(
          {
            hostId: state.hostId,
            registration: {
              clientId: issuedClientId,
              subject,
              ...(typeof payload.email === "string" && payload.email
                ? { email: payload.email }
                : {}),
            },
          },
          token,
        );
      });
      const enabled = token.scopes!.includes(DIRECT_SCOPE);
      this.log("oauth.authorization_succeeded", "info", { planUsage: enabled });
      return enabled ? { accessToken: token.accessToken } : undefined;
    } catch (error) {
      this.log("oauth.authorization_failed", "warn", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    } finally {
      if (this.authorizationController === controller) this.authorizationController = undefined;
      await listener?.close().catch(() => undefined);
    }
  }

  private async loadToken(): Promise<OAuthStoredToken | undefined> {
    const state = await this.store.loadOpenAICodexState();
    const token = await this.store.load(STORAGE_KEY);
    return state?.registration &&
      token?.issuer === ISSUER &&
      token.clientId === state.registration.clientId &&
      token.resource === RESOURCE
      ? token
      : undefined;
  }

  private async refreshToken(force = false): Promise<OAuthStoredToken | undefined> {
    if (this.refreshPromise) return this.refreshPromise;
    const before = await this.loadToken();
    if (!before?.refreshToken) return undefined;
    if (!force && isUsable(before)) return before;
    const controller = new AbortController();
    this.refreshController = controller;
    const signal = AbortSignal.any([this.signal, controller.signal]);
    // Reload inside the host lock before rotating a token shared by processes.
    const promise = this.store.withOpenAICodexLock(async () => {
      const current = await this.loadToken();
      if (!current?.refreshToken) return undefined;
      if (isUsable(current) && (!force || current.accessToken !== before.accessToken))
        return current;
      try {
        const refreshed = await refreshOAuthAccessToken({
          metadata: METADATA,
          client: { clientId: current.clientId, tokenEndpointAuthMethod: "none" },
          refreshToken: current.refreshToken,
          resource: RESOURCE,
          fetch: this.fetch,
          signal,
          onDiagnostic: this.onDiagnostic,
        });
        const token: OAuthStoredToken = {
          ...current,
          ...refreshed,
          idToken: refreshed.idToken ?? current.idToken,
          refreshToken: refreshed.refreshToken ?? current.refreshToken,
          scopes: refreshed.scopes ?? current.scopes,
        };
        signal.throwIfAborted();
        await this.store.save(STORAGE_KEY, token);
        return token;
      } catch (error) {
        if (
          error instanceof OAuthTokenEndpointError &&
          error.oauthError &&
          REJECTED_REFRESH_ERRORS.has(error.oauthError)
        ) {
          await this.store.delete(STORAGE_KEY);
          this.log("oauth.token_invalidated", "info", { reason: "refresh_rejected" });
          return undefined;
        }
        throw error;
      }
    });
    this.refreshPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.refreshPromise === promise) this.refreshPromise = undefined;
      if (this.refreshController === controller) this.refreshController = undefined;
    }
  }

  private async revokeSession(token: OAuthStoredToken): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const discovery = await this.fetch(`${ISSUER}/.well-known/openid-configuration`, {
          signal: this.signal,
        });
        if (!discovery.ok) throw new Error("OpenAI revocation discovery failed.");
        const metadata = (await discovery.json()) as { revocation_endpoint?: string };
        if (!metadata.revocation_endpoint)
          throw new Error("OpenAI revocation endpoint is missing.");
        const response = await this.fetch(metadata.revocation_endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: token.refreshToken!,
            token_type_hint: "refresh_token",
            client_id: token.clientId,
          }).toString(),
          signal: this.signal,
        });
        await response.body?.cancel();
        if (response.status === 200) return true;
        if (response.status < 500) break;
      } catch {
        if (this.signal.aborted) break;
      }
      if (attempt < 2) await setTimeout(250 * 2 ** attempt);
    }
    this.log("openai_codex_auth.revocation_failed", "warn", { attempts: 3 });
    return false;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("OpenAI Codex authentication is closed.");
    this.signal.throwIfAborted();
  }

  private assertCurrent(revision: number, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (revision !== this.revision) throw new Error("OpenAI Codex authentication changed.");
  }

  private readonly onDiagnostic = ({ event, level, ...metadata }: OAuthDiagnosticEvent): void => {
    this.log(event, level, metadata);
  };

  private log(
    event: string,
    level: "debug" | "info" | "warn",
    metadata: Record<string, unknown>,
  ): void {
    try {
      this.getLogger()[level](event, { component: "openai_codex_auth", ...metadata });
    } catch {
      // Diagnostics cannot change authentication or credential persistence.
    }
  }
}

export async function authorizeKanaOpenAICodex(options: CreateKanaOpenAICodexAuthOptions = {}) {
  const auth = new KanaOpenAICodexAuth(options);
  try {
    return await auth.authorize();
  } finally {
    auth.close();
  }
}

export async function getKanaOpenAICodexAuthStatus(options: CreateKanaOpenAICodexAuthOptions = {}) {
  const auth = new KanaOpenAICodexAuth(options);
  try {
    return await auth.getStatus();
  } finally {
    auth.close();
  }
}

export async function signOutKanaOpenAICodex(options: CreateKanaOpenAICodexAuthOptions = {}) {
  const auth = new KanaOpenAICodexAuth(options);
  try {
    await auth.signOut();
  } finally {
    auth.close();
  }
}

function isUsable(token: OAuthStoredToken): boolean {
  return token.expiresAt === undefined || token.expiresAt > Date.now() + 60_000;
}

function credentialsFromToken(token: OAuthStoredToken): OpenAICodexCredentials {
  if (!token.scopes?.includes(DIRECT_SCOPE)) {
    throw new Error(
      "ChatGPT plan usage is disabled. Run `kana auth login openai-codex` to enable it.",
    );
  }
  return { accessToken: token.accessToken };
}
