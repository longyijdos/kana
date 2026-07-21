import { describe, expect, test } from "bun:test";
import {
  McpAuthorizationChallengeError,
  McpOAuthHttpAuthorizer,
  type McpOAuthHttpDiagnosticEvent,
} from "../src/mcp";
import type { OAuthStoredToken, OAuthTokenStore } from "../src/oauth";

const RESOURCE = "https://api.example.com/mcp";
const ISSUER = "https://auth.example.com";

describe("MCP OAuth HTTP authorizer", () => {
  test("performs interactive step-up authorization and retries the challenged request once", async () => {
    const tokenStore = createMemoryTokenStore(storedToken());
    const diagnostics: McpOAuthHttpDiagnosticEvent[] = [];
    const resourceAuthorizations: Array<string | null> = [];
    const tokenRequests: URLSearchParams[] = [];
    let authorizationUrl: URL | undefined;

    const authorizer = new McpOAuthHttpAuthorizer({
      resource: RESOURCE,
      storageKey: "mcp:github",
      client: {
        clientId: "kana-client",
        clientSecret: "test-secret",
        tokenEndpointAuthMethod: "client_secret_post",
      },
      tokenStore,
      scopes: ["read:user", "repo"],
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.href === "https://api.example.com/.well-known/oauth-protected-resource/mcp") {
          return protectedResourceMetadata();
        }
        if (url.href === "https://auth.example.com/.well-known/oauth-authorization-server") {
          return authorizationServerMetadata();
        }
        if (url.href === "https://auth.example.com/token") {
          tokenRequests.push(new URLSearchParams(await request.text()));
          return Response.json({
            access_token: "expanded-token",
            token_type: "Bearer",
            refresh_token: "refresh-token",
            expires_in: 3_600,
            scope: "read:user repo",
          });
        }
        if (url.href === RESOURCE) {
          const authorization = request.headers.get("Authorization");
          resourceAuthorizations.push(authorization);
          if (authorization === "Bearer old-token") {
            return insufficientScopeResponse();
          }
          return Response.json({ ok: true });
        }
        throw new Error(`Unexpected OAuth test request: ${request.method} ${url.href}`);
      },
      openAuthorizationUrl: async (value) => {
        authorizationUrl = new URL(value);
        const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
        const state = authorizationUrl.searchParams.get("state");
        if (redirectUri === null || state === null) {
          throw new Error("Authorization URL did not contain redirect_uri and state.");
        }
        const callback = new URL(redirectUri);
        callback.searchParams.set("code", "authorization-code");
        callback.searchParams.set("state", state);
        const response = await fetch(callback);
        expect(response.status).toBe(200);
      },
      onDiagnostic: (event) => diagnostics.push(event),
    });

    await authorizer.prepare();
    const response = await authorizer.fetch(RESOURCE, { method: "POST", body: "{}" });

    expect(await response.json()).toEqual({ ok: true });
    expect(resourceAuthorizations).toEqual(["Bearer old-token", "Bearer expanded-token"]);
    expect(authorizationUrl?.searchParams.get("scope")).toBe("read:user repo");
    expect(authorizationUrl?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl?.searchParams.get("resource")).toBe(RESOURCE);
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.get("grant_type")).toBe("authorization_code");
    expect(tokenRequests[0]?.get("client_id")).toBe("kana-client");
    expect(tokenRequests[0]?.get("client_secret")).toBe("test-secret");
    expect(tokenRequests[0]?.get("resource")).toBe(RESOURCE);
    expect((await tokenStore.load("mcp:github"))?.scopes).toEqual(["read:user", "repo"]);
    expect(diagnostics).toContainEqual({
      event: "mcp.oauth_request_retried",
      level: "info",
      recovery: "interactive_authorization",
    });

    authorizer.close();
  });

  test("rejects a challenged scope outside the configured permission boundary", async () => {
    const tokenStore = createMemoryTokenStore(storedToken());
    const diagnostics: McpOAuthHttpDiagnosticEvent[] = [];
    let browserOpened = false;
    const authorizer = new McpOAuthHttpAuthorizer({
      resource: RESOURCE,
      storageKey: "mcp:github",
      client: { clientId: "kana-client" },
      tokenStore,
      scopes: ["read:user"],
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.href === "https://api.example.com/.well-known/oauth-protected-resource/mcp") {
          return protectedResourceMetadata();
        }
        if (url.href === "https://auth.example.com/.well-known/oauth-authorization-server") {
          return authorizationServerMetadata();
        }
        if (url.href === RESOURCE) {
          return insufficientScopeResponse();
        }
        throw new Error(`Unexpected OAuth test request: ${request.method} ${url.href}`);
      },
      openAuthorizationUrl: async () => {
        browserOpened = true;
      },
      onDiagnostic: (event) => diagnostics.push(event),
    });

    await authorizer.prepare();
    const error = await authorizer
      .fetch(RESOURCE, { method: "POST", body: "{}" })
      .catch((cause) => cause);

    expect(error).toBeInstanceOf(McpAuthorizationChallengeError);
    expect(error.message).toBe(
      "MCP HTTP authorization requires scopes that are not included in the configured OAuth scopes: repo.",
    );
    expect(browserOpened).toBe(false);
    expect(diagnostics).toContainEqual({
      event: "mcp.oauth_scope_challenge_blocked",
      level: "warn",
      configuredScopeCount: 1,
      challengedScopeCount: 2,
      missingScopeCount: 1,
    });

    authorizer.close();
  });
});

function storedToken(): OAuthStoredToken {
  return {
    accessToken: "old-token",
    tokenType: "Bearer",
    expiresAt: Date.now() + 3_600_000,
    scopes: ["read:user"],
    issuer: ISSUER,
    clientId: "kana-client",
    resource: RESOURCE,
  };
}

function createMemoryTokenStore(initial: OAuthStoredToken): OAuthTokenStore {
  let token: OAuthStoredToken | undefined = copyToken(initial);
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

function protectedResourceMetadata(): Response {
  return Response.json({
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: ["read:user", "repo"],
    bearer_methods_supported: ["header"],
  });
}

function authorizationServerMetadata(): Response {
  return Response.json({
    issuer: ISSUER,
    authorization_endpoint: "https://auth.example.com/authorize",
    token_endpoint: "https://auth.example.com/token",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
  });
}

function insufficientScopeResponse(): Response {
  return new Response(null, {
    status: 403,
    headers: {
      "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="read:user repo"',
    },
  });
}
