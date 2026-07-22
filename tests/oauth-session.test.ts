import { describe, expect, test } from "bun:test";
import {
  type OAuthDiagnosticEvent,
  OAuthSession,
  type OAuthStoredToken,
  type OAuthTokenStore,
} from "../src/oauth";

const NOW = 1_000_000;

describe("OAuth session", () => {
  test("coalesces refresh, rotates the access token, and preserves the refresh token", async () => {
    const store = createMemoryStore(expiredToken());
    const diagnostics: OAuthDiagnosticEvent[] = [];
    const requests: URLSearchParams[] = [];
    const session = new OAuthSession({
      storageKey: "account",
      metadata: metadata(),
      client: { clientId: "kana-client" },
      tokenStore: store,
      openAuthorizationUrl: async () => {},
      refreshSkewMs: 0,
      now: () => NOW,
      fetch: async (_input, init) => {
        requests.push(new URLSearchParams(String(init?.body)));
        await Promise.resolve();
        return Response.json({
          access_token: "refreshed-token",
          token_type: "bearer",
          expires_in: 3_600,
          scope: "read:user repo",
        });
      },
      onDiagnostic: (event) => diagnostics.push(event),
    });

    expect(await Promise.all([session.getAccessToken(), session.getAccessToken()])).toEqual([
      "refreshed-token",
      "refreshed-token",
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.get("grant_type")).toBe("refresh_token");
    expect(requests[0]?.get("refresh_token")).toBe("refresh-token");
    expect(requests[0]?.get("scope")).toBe("read:user");
    expect(await store.load("account")).toEqual({
      accessToken: "refreshed-token",
      tokenType: "Bearer",
      refreshToken: "refresh-token",
      expiresAt: NOW + 3_600_000,
      scopes: ["read:user", "repo"],
      issuer: "https://auth.example.com",
      clientId: "kana-client",
    });
    expect(diagnostics).toContainEqual({
      event: "oauth.token_request_succeeded",
      level: "info",
      grantType: "refresh_token",
      refreshTokenIssued: false,
      expiresAtPresent: true,
    });

    session.close();
  });

  test("invalidates stored credentials when the refresh token is rejected", async () => {
    const store = createMemoryStore(expiredToken());
    const diagnostics: OAuthDiagnosticEvent[] = [];
    const session = new OAuthSession({
      storageKey: "account",
      metadata: metadata(),
      client: { clientId: "kana-client" },
      tokenStore: store,
      openAuthorizationUrl: async () => {},
      refreshSkewMs: 0,
      now: () => NOW,
      fetch: async () =>
        Response.json(
          { error: "invalid_grant", error_description: "do not persist" },
          { status: 400 },
        ),
      onDiagnostic: (event) => diagnostics.push(event),
    });

    expect(await session.getAccessToken()).toBeUndefined();
    expect(await store.load("account")).toBeUndefined();
    expect(await session.getStatus()).toEqual({ state: "unauthorized", refreshable: false });
    expect(diagnostics).toContainEqual({
      event: "oauth.token_invalidated",
      level: "info",
      reason: "refresh_rejected",
    });

    session.close();
  });
});

function metadata() {
  return {
    issuer: "https://auth.example.com",
    authorizationEndpoint: "https://auth.example.com/authorize",
    tokenEndpoint: "https://auth.example.com/token",
    codeChallengeMethodsSupported: ["S256"],
    tokenEndpointAuthMethodsSupported: ["none"],
  };
}

function expiredToken(): OAuthStoredToken {
  return {
    accessToken: "expired-token",
    tokenType: "Bearer",
    refreshToken: "refresh-token",
    expiresAt: NOW,
    scopes: ["read:user"],
    issuer: "https://auth.example.com",
    clientId: "kana-client",
  };
}

function createMemoryStore(initial?: OAuthStoredToken): OAuthTokenStore {
  let token = initial === undefined ? undefined : copyToken(initial);
  return {
    async load() {
      return token === undefined ? undefined : copyToken(token);
    },
    async save(_key, next) {
      token = copyToken(next);
    },
    async delete() {
      token = undefined;
    },
  };
}

function copyToken(token: OAuthStoredToken): OAuthStoredToken {
  return {
    ...token,
    ...(token.scopes === undefined ? {} : { scopes: token.scopes.slice() }),
  };
}
