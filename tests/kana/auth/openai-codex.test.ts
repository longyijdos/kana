import { afterEach, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createKanaOAuthTokenStore, KanaOpenAICodexAuth } from "../../../src/kana";
import type { KanaOpenAICodexAuthState } from "../../../src/kana/auth/token-store";
import type { OAuthFetch, OAuthStoredToken } from "../../../src/oauth";
import { cleanupTempKanaHomes, createTempKanaHomeEnv } from "../../helpers/temp-kana-home";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const CLIENT_ID = "oaiapp_kana";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const TOKEN_EXPIRY = Date.now() + 3_600_000;
const { publicKey, privateKey } = await generateKeyPair("RS256");
const publicJwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256" };
afterEach(cleanupTempKanaHomes);

describe("Kana Sign in with ChatGPT", () => {
  test("registers kana, validates identity, and atomically replaces legacy credentials", async () => {
    const fixture = setup();
    const legacy = { ...token(), clientId: "app_legacy", resource: undefined };
    delete legacy.resource;
    await fixture.store.save("provider:openai-codex", legacy);
    expect(await fixture.auth.getCredentials()).toBeUndefined();
    expect(await fixture.store.load("provider:openai-codex")).toEqual(legacy);
    expect(await fixture.auth.authorize()).toEqual({ accessToken: "new-access" });
    const url = fixture.urls[0]!;
    expect(url.origin + url.pathname).toBe(`${ISSUER}/api/accounts/authorize`);
    expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(url.searchParams.get("agent_name_hint")).toBe("kana");
    expect(url.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "resource.invoke",
      DIRECT_SCOPE,
    ]);
    expect(url.searchParams.get("resource")).toBe(RESOURCE);
    expect(url.searchParams.get("nonce")).toBeTruthy();
    expect(fixture.forms[0]?.get("client_id")).toBe(CLIENT_ID);
    expect(fixture.forms[0]?.get("resource")).toBe(RESOURCE);
    expect(fixture.forms[0]?.get("redirect_uri")).toBe(url.searchParams.get("redirect_uri"));
    expect(fixture.forms[0]?.get("code_verifier")).toBeTruthy();
    expect((await fixture.store.loadOpenAICodexState())?.registration).toEqual({
      clientId: CLIENT_ID,
      subject: "subject",
      email: "user@example.com",
    });
    expect(await fixture.auth.getCredentials()).toEqual({ accessToken: "new-access" });
    expect(await fixture.auth.getStatus()).toMatchObject({ state: "authorized", planUsage: true });
    fixture.auth.close();
  });

  test("reauthorizes the saved registration with login hints and no new agent name", async () => {
    const fixture = setup({ callbackClientId: null });
    await fixture.store.saveOpenAICodexState(state(), token());
    await fixture.auth.authorize();
    const url = fixture.urls[0]!;
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("ext_agent_host_id")).toBe("urn:uuid:host");
    expect(url.searchParams.has("agent_name_hint")).toBe(false);
    expect(url.searchParams.get("id_token_hint")).toBe("retained-id-token");
    expect(url.searchParams.get("login_hint")).toBe("user@example.com");
    expect(url.searchParams.has("prompt")).toBe(false);
    fixture.auth.close();
  });

  for (const failure of [
    "signature",
    "nonce",
    "issuer",
    "audience",
    "expiry",
    "subject",
  ] as const) {
    test(`rejects invalid ${failure} without replacing the active account`, async () => {
      const fixture = setup({ failure, callbackClientId: null });
      await fixture.store.saveOpenAICodexState(state(), token());
      await expect(fixture.auth.authorize()).rejects.toThrow();
      expect(await fixture.store.load("provider:openai-codex")).toEqual(token());
      expect(await fixture.store.loadOpenAICodexState()).toEqual(state());
      fixture.auth.close();
    });
  }

  test("rejects missing or changed callback client IDs before exchanging a code", async () => {
    for (const existing of [false, true]) {
      const fixture = setup({ callbackClientId: existing ? "oaiapp_other" : null });
      if (existing) await fixture.store.saveOpenAICodexState(state(), token());
      await expect(fixture.auth.authorize()).rejects.toThrow("client");
      expect(fixture.forms).toHaveLength(0);
      fixture.auth.close();
    }
  });

  test("retains a pending client after failed exchange and reuses it on the next attempt", async () => {
    const fixture = setup({ exchangeError: "invalid_grant" });
    await expect(fixture.auth.authorize()).rejects.toThrow("invalid_grant");
    expect((await fixture.store.loadOpenAICodexState())?.pendingClientId).toBe(CLIENT_ID);
    fixture.options.exchangeError = undefined;
    fixture.options.callbackClientId = null;
    await fixture.auth.authorize();
    expect(fixture.urls[1]?.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(fixture.urls[1]?.searchParams.has("agent_name_hint")).toBe(false);
    expect(fixture.urls[1]?.searchParams.get("ext_agent_host_id")).toBe(
      fixture.urls[0]?.searchParams.get("ext_agent_host_id"),
    );
    fixture.auth.close();
  });

  test("keeps identity sign-in when direct permission is absent and requests consent on explicit login", async () => {
    const fixture = setup({ scope: "openid profile email offline_access" });
    expect(await fixture.auth.authorize()).toBeUndefined();
    expect(await fixture.auth.getStatus()).toMatchObject({ state: "authorized", planUsage: false });
    await expect(fixture.auth.getCredentials()).rejects.toThrow("plan usage is disabled");
    fixture.options.callbackClientId = null;
    fixture.options.scope = DIRECT_SCOPE;
    await fixture.auth.authorize();
    expect(fixture.urls[1]?.searchParams.get("prompt")).toBe("consent");
    expect(await fixture.auth.getCredentials()).toEqual({ accessToken: "new-access" });
    fixture.auth.close();
  });

  test("does not infer granted permissions from requested scopes", async () => {
    const fixture = setup({ scope: null });
    await fixture.auth.authorize();
    expect(await fixture.auth.getStatus()).toMatchObject({ planUsage: false, scopes: [] });
    fixture.auth.close();
  });

  test("a failed account switch preserves active credentials and its registration", async () => {
    const fixture = setup({ newAccount: true, exchangeError: "invalid_grant" });
    await fixture.store.saveOpenAICodexState(state(), token());
    await expect(fixture.auth.authorize()).rejects.toThrow();
    expect(fixture.urls[0]?.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(fixture.urls[0]?.searchParams.has("id_token_hint")).toBe(false);
    expect(await fixture.store.load("provider:openai-codex")).toEqual(token());
    expect((await fixture.store.loadOpenAICodexState())?.registration).toEqual(
      state().registration,
    );
    fixture.auth.close();
  });

  test("serializes refresh across auth instances, rotates tokens, and omits scope", async () => {
    const env = createTempKanaHomeEnv();
    const store = createKanaOAuthTokenStore({ env });
    await store.saveOpenAICodexState(state(), token(Date.now() - 1_000));
    let requests = 0;
    const fetch: OAuthFetch = async (input, init) => {
      expect(String(input)).toBe(`${ISSUER}/api/accounts/oauth/token`);
      expect(new Headers(init?.headers).get("content-type")).toBe(
        "application/x-www-form-urlencoded",
      );
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("client_id")).toBe(CLIENT_ID);
      expect(form.get("resource")).toBe(RESOURCE);
      expect(form.has("scope")).toBe(false);
      expect(form.get("refresh_token")).toBe("refresh-token");
      requests += 1;
      return Response.json({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        token_type: "Bearer",
        expires_in: 3_600,
      });
    };
    const first = new KanaOpenAICodexAuth({ env, fetch });
    const second = new KanaOpenAICodexAuth({ env, fetch });
    expect(await Promise.all([first.getCredentials(), second.getCredentials()])).toEqual([
      { accessToken: "rotated-access" },
      { accessToken: "rotated-access" },
    ]);
    expect(requests).toBe(1);
    expect(await store.load("provider:openai-codex")).toMatchObject({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
      idToken: "retained-id-token",
      scopes: [DIRECT_SCOPE],
    });
    first.close();
    second.close();
  });

  for (const error of [
    "invalid_refresh_token",
    "refresh_token_reused",
    "temporarily_unavailable",
  ]) {
    test(`handles refresh ${error} without deleting the registration`, async () => {
      const fixture = setup({ exchangeError: error });
      await fixture.store.saveOpenAICodexState(state(), token(Date.now() - 1_000));
      if (error === "temporarily_unavailable") {
        await expect(fixture.auth.getCredentials()).rejects.toThrow(error);
        expect(await fixture.store.load("provider:openai-codex")).toBeDefined();
      } else {
        expect(await fixture.auth.getCredentials()).toBeUndefined();
        expect(await fixture.store.load("provider:openai-codex")).toBeUndefined();
      }
      expect((await fixture.store.loadOpenAICodexState())?.registration).toEqual(
        state().registration,
      );
      fixture.auth.close();
    });
  }

  test("revokes the renewable session on logout and keeps the registration and host", async () => {
    const fixture = setup();
    await fixture.store.saveOpenAICodexState(state(), token());
    await fixture.auth.signOut();
    expect(fixture.revocations[0]?.get("token")).toBe("refresh-token");
    expect(fixture.revocations[0]?.get("client_id")).toBe(CLIENT_ID);
    expect(fixture.revocations[0]?.get("token_type_hint")).toBe("refresh_token");
    expect(await fixture.store.loadOpenAICodexState()).toEqual(state());
    expect(await fixture.auth.getCredentials()).toBeUndefined();
    fixture.auth.close();
  });

  test("reports unconfirmed remote revocation after clearing local credentials", async () => {
    const fixture = setup({ revocationStatus: 400 });
    await fixture.store.saveOpenAICodexState(state(), token());
    await expect(fixture.auth.signOut()).rejects.toThrow("Signed out locally");
    expect(await fixture.store.load("provider:openai-codex")).toBeUndefined();
    fixture.auth.close();
  });

  test("close prevents an in-flight authorization from restoring credentials", async () => {
    const fixture = setup();
    fixture.options.onExchange = () => fixture.auth.close();
    await expect(fixture.auth.authorize()).rejects.toThrow();
    expect(await fixture.store.load("provider:openai-codex")).toBeUndefined();
  });
});

type FixtureOptions = {
  newAccount?: boolean;
  callbackClientId?: string | null;
  failure?: "signature" | "nonce" | "issuer" | "audience" | "expiry" | "subject";
  scope?: string | null;
  exchangeError?: string;
  revocationStatus?: number;
  onExchange?: () => void;
};

function setup(options: FixtureOptions = {}) {
  const env = createTempKanaHomeEnv();
  const store = createKanaOAuthTokenStore({ env });
  const urls: URL[] = [];
  const forms: URLSearchParams[] = [];
  const revocations: URLSearchParams[] = [];
  let resolveCallback: (value: { code: string; clientId?: string }) => void;
  let expectedState: string;
  const auth = new KanaOpenAICodexAuth({
    env,
    tokenStore: store,
    newAccount: options.newAccount,
    startCallbackServer: async ({ redirectUri }) => ({
      redirectUri,
      waitForCallback: (state) => {
        expectedState = state;
        return new Promise((resolve) => {
          resolveCallback = resolve;
        });
      },
      close: async () => {},
    }),
    openAuthorizationUrl: async (value) => {
      const url = new URL(value);
      expect(url.searchParams.get("state")).toBe(expectedState);
      expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
      urls.push(url);
      resolveCallback({
        code: "code",
        ...(options.callbackClientId === null
          ? {}
          : { clientId: options.callbackClientId ?? CLIENT_ID }),
      });
    },
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/jwks.json")) return Response.json({ keys: [publicJwk] });
      if (url.endsWith("/openid-configuration")) {
        return Response.json({ revocation_endpoint: `${ISSUER}/revoke` });
      }
      if (url.endsWith("/revoke")) {
        revocations.push(new URLSearchParams(String(init?.body)));
        return new Response(null, { status: options.revocationStatus ?? 200 });
      }
      expect(url).toBe(`${ISSUER}/api/accounts/oauth/token`);
      forms.push(new URLSearchParams(String(init?.body)));
      options.onExchange?.();
      if (options.exchangeError)
        return Response.json({ error: options.exchangeError }, { status: 400 });
      let idToken = await new SignJWT({
        sub: options.failure === "subject" ? "another-subject" : "subject",
        email: "user@example.com",
        nonce: options.failure === "nonce" ? "wrong-nonce" : urls.at(-1)?.searchParams.get("nonce"),
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(options.failure === "issuer" ? "https://other.example" : ISSUER)
        .setAudience(options.failure === "audience" ? "other-client" : CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime(
          options.failure === "expiry" ? Math.floor(Date.now() / 1_000) - 60 : "1h",
        )
        .sign(privateKey);
      if (options.failure === "signature") {
        const parts = idToken.split(".");
        parts[2] = "invalid-signature";
        idToken = parts.join(".");
      }
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        id_token: idToken,
        token_type: "Bearer",
        expires_in: 3_600,
        ...(options.scope === null ? {} : { scope: options.scope ?? DIRECT_SCOPE }),
      });
    },
  });
  return { auth, store, options, urls, forms, revocations };
}

function state(): KanaOpenAICodexAuthState {
  return {
    hostId: "urn:uuid:host",
    registration: { clientId: CLIENT_ID, subject: "subject", email: "user@example.com" },
  };
}

function token(expiresAt = TOKEN_EXPIRY): OAuthStoredToken {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    idToken: "retained-id-token",
    tokenType: "Bearer",
    expiresAt,
    scopes: [DIRECT_SCOPE],
    issuer: ISSUER,
    clientId: CLIENT_ID,
    resource: RESOURCE,
  };
}
