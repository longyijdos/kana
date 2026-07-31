import { describe, expect, test } from "bun:test";
import { KanaOpenAICodexAuth } from "../src/kana";
import type { OAuthStoredToken, OAuthTokenStore } from "../src/oauth";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

describe("Kana OpenAI Codex authentication", () => {
  test("extracts the ChatGPT account ID from persisted credentials", async () => {
    const auth = new KanaOpenAICodexAuth({
      tokenStore: memoryStore({
        accessToken: jwt({ chatgpt_account_id: "account-id" }),
        tokenType: "Bearer",
        expiresAt: Date.now() + 3_600_000,
        issuer: "https://auth.openai.com",
        clientId: CLIENT_ID,
      }),
      openAuthorizationUrl: async () => {},
    });

    try {
      expect(await auth.getCredentials()).toEqual({
        accessToken: jwt({ chatgpt_account_id: "account-id" }),
        accountId: "account-id",
      });
    } finally {
      auth.close();
    }
  });

  test("sends refresh grants as JSON and accepts bearer responses without token_type", async () => {
    const request: { contentType?: string; body?: unknown } = {};
    const refreshedAccessToken = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "refreshed-account" },
    });
    const auth = new KanaOpenAICodexAuth({
      tokenStore: memoryStore({
        accessToken: jwt({ chatgpt_account_id: "old-account" }),
        tokenType: "Bearer",
        refreshToken: "refresh-token",
        expiresAt: 0,
        scopes: ["openid"],
        issuer: "https://auth.openai.com",
        clientId: CLIENT_ID,
      }),
      openAuthorizationUrl: async () => {},
      fetch: async (_input, init) => {
        request.contentType = new Headers(init?.headers).get("content-type") ?? undefined;
        request.body = JSON.parse(String(init?.body));
        return Response.json({
          access_token: refreshedAccessToken,
          expires_in: 3_600,
        });
      },
    });

    try {
      expect(await auth.refreshCredentials()).toEqual({
        accessToken: refreshedAccessToken,
        accountId: "refreshed-account",
      });
      expect(request.contentType).toBe("application/json");
      expect(request.body).toMatchObject({
        grant_type: "refresh_token",
        refresh_token: "refresh-token",
        client_id: CLIENT_ID,
      });
    } finally {
      auth.close();
    }
  });
});

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

function memoryStore(initial: OAuthStoredToken): OAuthTokenStore {
  let token: OAuthStoredToken | undefined = structuredClone(initial);
  return {
    async load() {
      return token === undefined ? undefined : structuredClone(token);
    },
    async save(_storageKey, next) {
      token = structuredClone(next);
    },
    async delete() {
      token = undefined;
    },
  };
}
