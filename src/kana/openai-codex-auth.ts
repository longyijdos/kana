import { createNoopLogger, type Logger } from "@/logging";
import {
  type OAuthDiagnosticEvent,
  type OAuthFetch,
  OAuthSession,
  type OAuthSessionStatus,
  type OAuthStoredToken,
  type OAuthTokenStore,
} from "@/oauth";
import type { OpenAICodexCredentialProvider, OpenAICodexCredentials } from "@/providers";
import { openKanaOAuthAuthorizationUrl } from "./oauth-browser";
import { createKanaOAuthTokenStore } from "./oauth-token-store";

const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_AUTH_BASE_URL = "https://auth.openai.com";
const OPENAI_CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const OPENAI_CODEX_SCOPES = ["openid", "profile", "email", "offline_access"] as const;
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

export const KANA_OPENAI_CODEX_OAUTH_STORAGE_KEY = "provider:openai-codex";

export type CreateKanaOpenAICodexAuthOptions = {
  env?: NodeJS.ProcessEnv;
  getLogger?: () => Logger;
  tokenStore?: OAuthTokenStore;
  openAuthorizationUrl?(url: string): Promise<void>;
  fetch?: OAuthFetch;
  signal?: AbortSignal;
};

export class KanaOpenAICodexAuth implements OpenAICodexCredentialProvider {
  private readonly session: OAuthSession;

  constructor(options: CreateKanaOpenAICodexAuthOptions = {}) {
    const env = { ...(options.env ?? process.env) };
    const getLogger = options.getLogger ?? createNoopLogger;
    const tokenStore = options.tokenStore ?? createKanaOAuthTokenStore({ env, getLogger });
    const openAuthorizationUrl =
      options.openAuthorizationUrl ??
      ((url: string) => openKanaOAuthAuthorizationUrl(url, { getLogger }));
    const fetch = createOpenAICodexOAuthFetch(options.fetch ?? globalThis.fetch);

    this.session = new OAuthSession({
      storageKey: KANA_OPENAI_CODEX_OAUTH_STORAGE_KEY,
      metadata: {
        issuer: OPENAI_CODEX_AUTH_BASE_URL,
        authorizationEndpoint: `${OPENAI_CODEX_AUTH_BASE_URL}/oauth/authorize`,
        tokenEndpoint: `${OPENAI_CODEX_AUTH_BASE_URL}/oauth/token`,
        codeChallengeMethodsSupported: ["S256"],
        tokenEndpointAuthMethodsSupported: ["none"],
      },
      client: {
        clientId: OPENAI_CODEX_CLIENT_ID,
        tokenEndpointAuthMethod: "none",
      },
      redirectUri: OPENAI_CODEX_REDIRECT_URI,
      tokenStore,
      openAuthorizationUrl,
      scopes: OPENAI_CODEX_SCOPES,
      additionalAuthorizationParameters: {
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: "kana",
      },
      // The Codex authorization service has returned bearer-only token
      // responses without the otherwise standard token_type field.
      acceptMissingBearerTokenType: true,
      fetch,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onDiagnostic: createDiagnosticHandler(getLogger),
    });
  }

  async authorize(): Promise<OpenAICodexCredentials> {
    await this.session.authorize();
    const token = await this.session.getToken();
    if (token === undefined) {
      throw new Error("OpenAI Codex authorization completed without storing credentials.");
    }
    return credentialsFromToken(token);
  }

  async getCredentials(): Promise<OpenAICodexCredentials | undefined> {
    const token = await this.session.getToken();
    return token === undefined ? undefined : credentialsFromToken(token);
  }

  async refreshCredentials(): Promise<OpenAICodexCredentials | undefined> {
    const token = await this.session.refresh();
    return token === undefined ? undefined : credentialsFromToken(token);
  }

  getStatus(): Promise<OAuthSessionStatus> {
    return this.session.getStatus();
  }

  signOut(): Promise<void> {
    return this.session.signOut();
  }

  close(): void {
    this.session.close();
  }
}

export async function authorizeKanaOpenAICodex(
  options: CreateKanaOpenAICodexAuthOptions = {},
): Promise<OpenAICodexCredentials> {
  const auth = new KanaOpenAICodexAuth(options);
  try {
    return await auth.authorize();
  } finally {
    auth.close();
  }
}

export async function getKanaOpenAICodexAuthStatus(
  options: CreateKanaOpenAICodexAuthOptions = {},
): Promise<OAuthSessionStatus> {
  const auth = new KanaOpenAICodexAuth(options);
  try {
    return await auth.getStatus();
  } finally {
    auth.close();
  }
}

export async function signOutKanaOpenAICodex(
  options: CreateKanaOpenAICodexAuthOptions = {},
): Promise<void> {
  const auth = new KanaOpenAICodexAuth(options);
  try {
    await auth.signOut();
  } finally {
    auth.close();
  }
}

function credentialsFromToken(token: OAuthStoredToken): OpenAICodexCredentials {
  const accountId =
    extractChatGptAccountId(token.idToken) ?? extractChatGptAccountId(token.accessToken);
  if (accountId === undefined) {
    throw new Error("OpenAI Codex credentials do not contain a ChatGPT account ID.");
  }
  return {
    accessToken: token.accessToken,
    accountId,
  };
}

function extractChatGptAccountId(token: string | undefined): string | undefined {
  if (token === undefined) {
    return undefined;
  }

  try {
    const payload = token.split(".")[1];
    if (!payload) {
      return undefined;
    }
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const direct = claims.chatgpt_account_id;
    if (typeof direct === "string" && direct.length > 0) {
      return direct;
    }
    const auth = claims[OPENAI_AUTH_CLAIM];
    if (typeof auth !== "object" || auth === null || Array.isArray(auth)) {
      return undefined;
    }
    const nested = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof nested === "string" && nested.length > 0 ? nested : undefined;
  } catch {
    return undefined;
  }
}

function createDiagnosticHandler(getLogger: () => Logger): (event: OAuthDiagnosticEvent) => void {
  return ({ event, level, ...metadata }) => {
    try {
      getLogger()[level](event, {
        component: "openai_codex_auth",
        provider: "openai-codex",
        ...metadata,
      });
    } catch {
      // Authorization and credential persistence do not depend on diagnostic logging.
    }
  };
}

function createOpenAICodexOAuthFetch(fetch: OAuthFetch): OAuthFetch {
  return (input, init = {}) => {
    if (typeof init.body !== "string") {
      return fetch(input, init);
    }
    const parameters = new URLSearchParams(init.body);
    if (parameters.get("grant_type") !== "refresh_token") {
      return fetch(input, init);
    }

    // The current Codex client sends refresh grants as JSON, while the
    // authorization-code exchange remains form encoded.
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    return fetch(input, {
      ...init,
      headers,
      body: JSON.stringify(Object.fromEntries(parameters)),
    });
  };
}
