import { readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { Type } from "typebox";
import type { Logger } from "@/logging";
import type { McpOAuthClientRegistration, McpOAuthClientStore } from "@/mcp";
import type { OAuthStoredToken, OAuthTokenStatus, OAuthTokenStore } from "@/oauth";
import {
  nonEmptyString,
  parseWithSchema,
  SerialTaskQueue,
  strictObject,
  writeFileAtomic,
} from "@/utils";
import { getKanaConfigPaths } from "../path";

const TOKEN_FILE_VERSION = 1;

type KanaOAuthTokenFile = {
  version: typeof TOKEN_FILE_VERSION;
  tokens: Record<string, OAuthStoredToken>;
  clients?: Record<string, McpOAuthClientRegistration>;
  openaiCodex?: KanaOpenAICodexAuthState;
};

export type KanaOpenAICodexAuthState = {
  hostId: string;
  registration?: { clientId: string; subject: string; email?: string };
  pendingClientId?: string;
};

export type KanaOpenAICodexAuthStore = OAuthTokenStore & {
  loadOpenAICodexState(): Promise<KanaOpenAICodexAuthState | undefined>;
  saveOpenAICodexState(state: KanaOpenAICodexAuthState, token?: OAuthStoredToken): Promise<void>;
  withOpenAICodexLock<T>(operation: () => Promise<T>): Promise<T>;
};

export type CreateKanaOAuthTokenStoreOptions = {
  env?: NodeJS.ProcessEnv;
  getLogger?: () => Logger;
};

export type LoadKanaOAuthTokenStatusesOptions = {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

export function createKanaOAuthTokenStore(
  options: CreateKanaOAuthTokenStoreOptions = {},
): KanaOpenAICodexAuthStore & McpOAuthClientStore {
  const filePath = getOAuthTokenFilePath(options.env);
  return new KanaOAuthTokenStore(filePath, options.getLogger);
}

export function loadKanaOAuthTokenStatuses(
  storageKeys: readonly string[],
  options: LoadKanaOAuthTokenStatusesOptions = {},
): Record<string, OAuthTokenStatus> {
  if (storageKeys.length === 0) {
    return {};
  }

  let file: KanaOAuthTokenFile;
  try {
    file = parseTokenFile(JSON.parse(readFileSync(getOAuthTokenFilePath(options.env), "utf8")));
  } catch (error) {
    if (isFileNotFound(error)) {
      file = { version: TOKEN_FILE_VERSION, tokens: {} };
    } else {
      throw new Error("Failed to read the OAuth token store.", { cause: error });
    }
  }

  const now = options.now?.() ?? Date.now();
  return Object.fromEntries(
    storageKeys.map((storageKey) => {
      const token = file.tokens[storageKey];
      return [storageKey, token === undefined ? unauthorizedStatus() : tokenStatus(token, now)];
    }),
  );
}

class KanaOAuthTokenStore implements KanaOpenAICodexAuthStore, McpOAuthClientStore {
  private readonly operations = new SerialTaskQueue();

  constructor(
    private readonly filePath: string,
    private readonly getLogger?: () => Logger,
  ) {}

  load(key: string): Promise<OAuthStoredToken | undefined> {
    return this.enqueue(async () => {
      const file = await this.readFile();
      return file.tokens[key];
    });
  }

  save(key: string, token: OAuthStoredToken): Promise<void> {
    return this.mutate((file) => {
      file.tokens[key] = token;
      return true;
    });
  }

  delete(key: string): Promise<void> {
    return this.mutate((file) => {
      if (!(key in file.tokens)) {
        return false;
      }
      delete file.tokens[key];
      return true;
    });
  }

  loadOpenAICodexState(): Promise<KanaOpenAICodexAuthState | undefined> {
    return this.enqueue(async () => {
      return (await this.readFile()).openaiCodex;
    });
  }

  saveOpenAICodexState(state: KanaOpenAICodexAuthState, token?: OAuthStoredToken): Promise<void> {
    return this.mutate((file) => {
      file.openaiCodex = state;
      if (token !== undefined) file.tokens["provider:openai-codex"] = token;
      return true;
    });
  }

  withOpenAICodexLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.withLock(`${this.filePath}.openai-codex`, operation);
  }

  loadClient(key: string): Promise<McpOAuthClientRegistration | undefined> {
    return this.enqueue(async () => {
      return (await this.readFile()).clients?.[key];
    });
  }

  saveClient(key: string, registration: McpOAuthClientRegistration): Promise<void> {
    return this.mutate((file) => {
      file.clients ??= {};
      file.clients[key] = registration;
      return true;
    });
  }

  deleteClient(key: string): Promise<void> {
    return this.mutate((file) => {
      if (file.clients?.[key] === undefined) return false;
      delete file.clients[key];
      return true;
    });
  }

  private mutate(update: (file: KanaOAuthTokenFile) => boolean): Promise<void> {
    return this.enqueue(() =>
      this.withLock(this.filePath, async () => {
        const file = await this.readFile();
        if (update(file)) await this.writeFile(file);
      }),
    );
  }

  private async withLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
    // Codex lifecycle operations may acquire the file lock; file mutations
    // never acquire the lifecycle lock or hold the file lock across network I/O.
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(target, {
        realpath: false,
        retries: { retries: 10, minTimeout: 100, maxTimeout: 1_000 },
      });
    } catch (error) {
      this.logFailure("oauth.token_store_lock_failed", error);
      throw new Error("Failed to lock the OAuth token store.", { cause: error });
    }
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return this.operations.run(operation);
  }

  private async readFile(): Promise<KanaOAuthTokenFile> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        return { version: TOKEN_FILE_VERSION, tokens: {} };
      }
      this.logFailure("oauth.token_store_read_failed", error);
      throw new Error("Failed to read the OAuth token store.", { cause: error });
    }

    try {
      return parseTokenFile(JSON.parse(content));
    } catch (error) {
      this.logFailure("oauth.token_store_parse_failed", error);
      throw new Error("Failed to parse the OAuth token store.", { cause: error });
    }
  }

  private async writeFile(file: KanaOAuthTokenFile): Promise<void> {
    try {
      writeFileAtomic(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
    } catch (error) {
      this.logFailure("oauth.token_store_write_failed", error);
      throw new Error("Failed to write the OAuth token store.", { cause: error });
    }
  }

  private logFailure(event: string, error: unknown): void {
    this.getLogger?.().warn(event, { component: "oauth_token_store", error });
  }
}

const STORED_TOKEN_SCHEMA = strictObject({
  accessToken: nonEmptyString(),
  tokenType: Type.Literal("Bearer"),
  idToken: Type.Optional(nonEmptyString()),
  refreshToken: Type.Optional(nonEmptyString()),
  expiresAt: Type.Optional(
    Type.Number({ exclusiveMinimum: 0, errorMessage: "must be a positive timestamp" }),
  ),
  scopes: Type.Optional(Type.Array(nonEmptyString())),
  issuer: nonEmptyString(),
  clientId: nonEmptyString(),
  resource: Type.Optional(nonEmptyString()),
});

const CLIENT_REGISTRATION_SCHEMA = Type.Object({
  issuer: nonEmptyString(),
  resource: nonEmptyString(),
  redirectUri: nonEmptyString(),
  client: Type.Object({
    clientId: nonEmptyString(),
    clientSecret: Type.Optional(nonEmptyString()),
    tokenEndpointAuthMethod: Type.Optional(
      Type.Enum(["none", "client_secret_basic", "client_secret_post"]),
    ),
  }),
});

const OPENAI_CODEX_STATE_SCHEMA = Type.Object({
  hostId: nonEmptyString(),
  pendingClientId: Type.Optional(nonEmptyString()),
  registration: Type.Optional(
    Type.Object({
      clientId: nonEmptyString(),
      subject: nonEmptyString(),
      email: Type.Optional(nonEmptyString()),
    }),
  ),
});

const TOKEN_FILE_SCHEMA = Type.Object({
  version: Type.Literal(TOKEN_FILE_VERSION, { errorMessage: `must be ${TOKEN_FILE_VERSION}` }),
  tokens: Type.Record(Type.String(), STORED_TOKEN_SCHEMA),
  clients: Type.Optional(Type.Record(Type.String(), CLIENT_REGISTRATION_SCHEMA)),
  openaiCodex: Type.Optional(OPENAI_CODEX_STATE_SCHEMA),
});

function parseTokenFile(value: unknown): KanaOAuthTokenFile {
  return parseWithSchema(TOKEN_FILE_SCHEMA, value, "OAuth token store");
}

function getOAuthTokenFilePath(env: NodeJS.ProcessEnv | undefined): string {
  return path.join(getKanaConfigPaths(env).home, "oauth-tokens.json");
}

function unauthorizedStatus(): OAuthTokenStatus {
  return { state: "unauthorized", refreshable: false };
}

function tokenStatus(token: OAuthStoredToken, now: number): OAuthTokenStatus {
  return {
    state: token.expiresAt !== undefined && token.expiresAt <= now ? "expired" : "authorized",
    refreshable: token.refreshToken !== undefined,
    ...(token.expiresAt === undefined ? {} : { expiresAt: token.expiresAt }),
  };
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
