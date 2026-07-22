import { OAuthError, OAuthProtocolError, OAuthTokenEndpointError } from "./errors";
import {
  assertOAuthMaxResponseBytes,
  DEFAULT_OAUTH_MAX_RESPONSE_BYTES,
  describeOAuthErrorIdentity,
  readOAuthJsonResponse,
} from "./http";
import { createOAuthPkcePair, createOAuthState } from "./pkce";
import type {
  OAuthAuthorizationRequest,
  OAuthAuthorizationServerMetadata,
  OAuthClientCredentials,
  OAuthDiagnosticHandler,
  OAuthFetch,
  OAuthTokenEndpointAuthMethod,
  OAuthTokenSet,
} from "./types";

const RESERVED_AUTHORIZATION_PARAMETERS = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "resource",
]);

export type CreateOAuthAuthorizationRequestOptions = {
  metadata: OAuthAuthorizationServerMetadata;
  client: OAuthClientCredentials;
  redirectUri: string;
  scopes?: readonly string[];
  resource?: string;
  additionalParameters?: Readonly<Record<string, string>>;
};

export type ExchangeOAuthAuthorizationCodeOptions = {
  metadata: OAuthAuthorizationServerMetadata;
  client: OAuthClientCredentials;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  resource?: string;
  fetch?: OAuthFetch;
  maxResponseBytes?: number;
  onDiagnostic?: OAuthDiagnosticHandler;
  now?: () => number;
  signal?: AbortSignal;
};

export type RefreshOAuthAccessTokenOptions = {
  metadata: OAuthAuthorizationServerMetadata;
  client: OAuthClientCredentials;
  refreshToken: string;
  resource?: string;
  scopes?: readonly string[];
  fetch?: OAuthFetch;
  maxResponseBytes?: number;
  onDiagnostic?: OAuthDiagnosticHandler;
  now?: () => number;
  signal?: AbortSignal;
};

type TokenRequestOptions = {
  metadata: OAuthAuthorizationServerMetadata;
  client: OAuthClientCredentials;
  grantType: "authorization_code" | "refresh_token";
  parameters: URLSearchParams;
  fetch?: OAuthFetch;
  maxResponseBytes?: number;
  onDiagnostic?: OAuthDiagnosticHandler;
  now?: () => number;
  signal?: AbortSignal;
};

export function createOAuthAuthorizationRequest(
  options: CreateOAuthAuthorizationRequestOptions,
): OAuthAuthorizationRequest {
  validateClient(options.client);
  validateRedirectUri(options.redirectUri);
  validateScopes(options.scopes);
  if (!options.metadata.codeChallengeMethodsSupported?.includes("S256")) {
    throw new OAuthProtocolError(
      "OAuth authorization server metadata does not declare PKCE S256 support.",
    );
  }

  const pkce = createOAuthPkcePair();
  const state = createOAuthState();
  const authorizationUrl = new URL(options.metadata.authorizationEndpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", options.client.clientId);
  authorizationUrl.searchParams.set("redirect_uri", options.redirectUri);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", pkce.codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", pkce.codeChallengeMethod);

  if (options.scopes !== undefined && options.scopes.length > 0) {
    authorizationUrl.searchParams.set("scope", options.scopes.join(" "));
  }
  if (options.resource !== undefined) {
    authorizationUrl.searchParams.set("resource", validateResource(options.resource));
  }
  for (const [name, value] of Object.entries(options.additionalParameters ?? {})) {
    if (RESERVED_AUTHORIZATION_PARAMETERS.has(name)) {
      throw new OAuthProtocolError(`OAuth additional parameter cannot override ${name}.`);
    }
    if (!name || !value) {
      throw new OAuthProtocolError("OAuth additional parameters must be non-empty strings.");
    }
    authorizationUrl.searchParams.set(name, value);
  }

  return {
    authorizationUrl: authorizationUrl.toString(),
    state,
    ...pkce,
  };
}

export async function exchangeOAuthAuthorizationCode(
  options: ExchangeOAuthAuthorizationCodeOptions,
): Promise<OAuthTokenSet> {
  validateClient(options.client);
  validateRedirectUri(options.redirectUri);
  if (!options.code) {
    throw new OAuthProtocolError("OAuth authorization code cannot be empty.");
  }
  validateCodeVerifier(options.codeVerifier);

  const parameters = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    code_verifier: options.codeVerifier,
  });
  if (options.resource !== undefined) {
    parameters.set("resource", validateResource(options.resource));
  }

  return requestToken({ ...options, grantType: "authorization_code", parameters });
}

export async function refreshOAuthAccessToken(
  options: RefreshOAuthAccessTokenOptions,
): Promise<OAuthTokenSet> {
  validateClient(options.client);
  validateScopes(options.scopes);
  if (!options.refreshToken) {
    throw new OAuthProtocolError("OAuth refresh token cannot be empty.");
  }

  const parameters = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
  });
  if (options.resource !== undefined) {
    parameters.set("resource", validateResource(options.resource));
  }
  if (options.scopes !== undefined && options.scopes.length > 0) {
    parameters.set("scope", options.scopes.join(" "));
  }

  return requestToken({ ...options, grantType: "refresh_token", parameters });
}

async function requestToken(options: TokenRequestOptions): Promise<OAuthTokenSet> {
  assertOAuthMaxResponseBytes(options.maxResponseBytes);
  const authMethod = selectTokenEndpointAuthMethod(options.metadata, options.client);
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  });
  applyClientAuthentication(headers, options.parameters, options.client, authMethod);

  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(options.metadata.tokenEndpoint, {
      method: "POST",
      headers,
      body: options.parameters.toString(),
      redirect: "error",
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? error;
    }
    emitDiagnostic(options.onDiagnostic, {
      event: "oauth.token_request_failed",
      level: "warn",
      grantType: options.grantType,
      errorIdentity: describeOAuthErrorIdentity(error),
    });
    throw new OAuthError("OAuth token request failed.", { cause: error });
  }

  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_OAUTH_MAX_RESPONSE_BYTES;
  let value: unknown;
  try {
    value = await readOAuthJsonResponse(response, maxResponseBytes);
  } catch (error) {
    emitDiagnostic(options.onDiagnostic, {
      event: "oauth.token_request_failed",
      level: "warn",
      grantType: options.grantType,
      status: response.status,
      errorIdentity: describeOAuthErrorIdentity(error),
    });
    throw error;
  }

  if (!response.ok) {
    const oauthError = readSafeOAuthError(value);
    emitDiagnostic(options.onDiagnostic, {
      event: "oauth.token_request_failed",
      level: "warn",
      grantType: options.grantType,
      status: response.status,
      ...(oauthError === undefined ? {} : { oauthError }),
    });
    throw new OAuthTokenEndpointError(response.status, oauthError);
  }

  const tokenSet = parseTokenSet(value, options.now?.() ?? Date.now());
  emitDiagnostic(options.onDiagnostic, {
    event: "oauth.token_request_succeeded",
    level: "info",
    grantType: options.grantType,
    refreshTokenIssued: tokenSet.refreshToken !== undefined,
    expiresAtPresent: tokenSet.expiresAt !== undefined,
  });
  return tokenSet;
}

function selectTokenEndpointAuthMethod(
  metadata: OAuthAuthorizationServerMetadata,
  client: OAuthClientCredentials,
): OAuthTokenEndpointAuthMethod {
  const configured = client.tokenEndpointAuthMethod;
  if (configured !== undefined) {
    assertAuthMethodUsable(configured, client);
    if (
      metadata.tokenEndpointAuthMethodsSupported !== undefined &&
      !metadata.tokenEndpointAuthMethodsSupported.includes(configured)
    ) {
      throw new OAuthProtocolError(
        `OAuth authorization server does not support token endpoint auth method ${configured}.`,
      );
    }
    return configured;
  }

  const supported = metadata.tokenEndpointAuthMethodsSupported;
  if (client.clientSecret !== undefined) {
    if (supported === undefined || supported.includes("client_secret_basic")) {
      return "client_secret_basic";
    }
    if (supported.includes("client_secret_post")) {
      return "client_secret_post";
    }
    throw new OAuthProtocolError(
      "OAuth authorization server does not support an available client secret method.",
    );
  }

  if (supported === undefined || supported.includes("none")) {
    return "none";
  }
  throw new OAuthProtocolError(
    "OAuth authorization server requires client authentication, but no client secret is configured.",
  );
}

function assertAuthMethodUsable(
  method: OAuthTokenEndpointAuthMethod,
  client: OAuthClientCredentials,
): void {
  if (method !== "none" && client.clientSecret === undefined) {
    throw new OAuthProtocolError(`OAuth token endpoint auth method ${method} requires a secret.`);
  }
}

function applyClientAuthentication(
  headers: Headers,
  parameters: URLSearchParams,
  client: OAuthClientCredentials,
  method: OAuthTokenEndpointAuthMethod,
): void {
  if (method === "client_secret_basic") {
    const clientId = encodeFormComponent(client.clientId);
    const clientSecret = encodeFormComponent(client.clientSecret!);
    headers.set(
      "Authorization",
      `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    );
    return;
  }

  parameters.set("client_id", client.clientId);
  if (method === "client_secret_post") {
    parameters.set("client_secret", client.clientSecret!);
  }
}

function parseTokenSet(value: unknown, now: number): OAuthTokenSet {
  if (!isJsonObject(value)) {
    throw new OAuthProtocolError("OAuth token response must be a JSON object.");
  }
  if (typeof value.access_token !== "string" || value.access_token.length === 0) {
    throw new OAuthProtocolError("OAuth token response is missing access_token.");
  }
  if (typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer") {
    throw new OAuthProtocolError("OAuth token response must use the Bearer token type.");
  }

  const refreshToken = readOptionalNonEmptyString(value, "refresh_token");
  const expiresIn = readExpiresIn(value.expires_in);
  const scope = readOptionalNonEmptyString(value, "scope");

  return {
    accessToken: value.access_token,
    tokenType: "Bearer",
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(expiresIn === undefined ? {} : { expiresAt: now + expiresIn * 1_000 }),
    ...(scope === undefined ? {} : { scopes: scope.split(/\s+/) }),
  };
}

function readExpiresIn(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new OAuthProtocolError("OAuth token response expires_in must be a positive number.");
  }
  return value;
}

function readOptionalNonEmptyString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) {
    return undefined;
  }
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new OAuthProtocolError(`OAuth token response ${key} must be a non-empty string.`);
  }
  return candidate;
}

function readSafeOAuthError(value: unknown): string | undefined {
  if (!isJsonObject(value) || typeof value.error !== "string") {
    return undefined;
  }
  return /^[a-zA-Z0-9_.-]{1,64}$/.test(value.error) ? value.error : undefined;
}

function validateClient(client: OAuthClientCredentials): void {
  if (!client.clientId) {
    throw new OAuthProtocolError("OAuth client ID cannot be empty.");
  }
  if (client.clientSecret !== undefined && !client.clientSecret) {
    throw new OAuthProtocolError("OAuth client secret cannot be empty.");
  }
}

function validateCodeVerifier(value: string): void {
  if (value.length < 43 || value.length > 128 || !/^[a-zA-Z0-9._~-]+$/.test(value)) {
    throw new OAuthProtocolError("OAuth PKCE code verifier is invalid.");
  }
}

function validateRedirectUri(value: string): void {
  const url = parseAbsoluteUrl(value, "OAuth redirect URI");
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new OAuthProtocolError("OAuth redirect URI must use HTTPS or an HTTP loopback host.");
  }
}

function validateResource(value: string): string {
  const url = parseAbsoluteUrl(value, "OAuth resource");
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new OAuthProtocolError("OAuth resource must use HTTP or HTTPS.");
  }
  return value;
}

function parseAbsoluteUrl(value: string, description: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new OAuthProtocolError(`${description} must be an absolute URL.`, { cause: error });
  }
  if (url.username || url.password) {
    throw new OAuthProtocolError(`${description} cannot contain credentials.`);
  }
  if (url.hash) {
    throw new OAuthProtocolError(`${description} cannot contain a fragment.`);
  }
  return url;
}

function validateScopes(scopes: readonly string[] | undefined): void {
  if (scopes?.some((scope) => !scope || /[\s\x00-\x20\x7f]/.test(scope))) {
    throw new OAuthProtocolError("OAuth scopes must be non-empty tokens without whitespace.");
  }
}

function encodeFormComponent(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emitDiagnostic(
  handler: OAuthDiagnosticHandler | undefined,
  event: Parameters<OAuthDiagnosticHandler>[0],
): void {
  try {
    handler?.(event);
  } catch {
    // Diagnostic consumers cannot alter token acquisition or refresh.
  }
}
