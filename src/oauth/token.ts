import {
  OAUTH_TOKEN_ENDPOINT_AUTH_METHODS,
  type OAuthStoredToken,
  type OAuthTokenEndpointAuthMethod,
  type OAuthTokenStatus,
} from "./types";

// Tokens are refreshed this long before they expire so a request started just
// before expiry does not reach the server with a stale credential.
const REFRESH_MARGIN_MS = 60_000;

export function needsOAuthTokenRefresh(token: OAuthStoredToken, now = Date.now()): boolean {
  return token.expiresAt !== undefined && token.expiresAt <= now + REFRESH_MARGIN_MS;
}

export function getOAuthTokenStatus(
  token: OAuthStoredToken | undefined,
  now = Date.now(),
): OAuthTokenStatus {
  if (token === undefined) {
    return { state: "unauthorized", refreshable: false };
  }
  return {
    state: token.expiresAt !== undefined && token.expiresAt <= now ? "expired" : "authorized",
    refreshable: token.refreshToken !== undefined,
    ...(token.expiresAt === undefined ? {} : { expiresAt: token.expiresAt }),
  };
}

export function isOAuthTokenEndpointAuthMethod(
  value: string,
): value is OAuthTokenEndpointAuthMethod {
  return (OAUTH_TOKEN_ENDPOINT_AUTH_METHODS as readonly string[]).includes(value);
}
