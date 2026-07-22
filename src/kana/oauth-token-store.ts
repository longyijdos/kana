import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "@/logging";
import type { OAuthStoredToken, OAuthTokenStore } from "@/oauth";
import { getKanaConfigPaths } from "./config";

const TOKEN_FILE_VERSION = 1;

type KanaOAuthTokenFile = {
  version: typeof TOKEN_FILE_VERSION;
  tokens: Record<string, OAuthStoredToken>;
};

export type CreateKanaOAuthTokenStoreOptions = {
  env?: NodeJS.ProcessEnv;
  getLogger?: () => Logger;
};

export type KanaOAuthTokenStatus = {
  state: "unauthorized" | "authorized" | "expired";
  refreshable: boolean;
  expiresAt?: number;
};

export type LoadKanaOAuthTokenStatusesOptions = {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

export function createKanaOAuthTokenStore(
  options: CreateKanaOAuthTokenStoreOptions = {},
): OAuthTokenStore {
  const filePath = getOAuthTokenFilePath(options.env);
  return new KanaOAuthTokenStore(filePath, options.getLogger);
}

export function loadKanaOAuthTokenStatuses(
  storageKeys: readonly string[],
  options: LoadKanaOAuthTokenStatusesOptions = {},
): Record<string, KanaOAuthTokenStatus> {
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

class KanaOAuthTokenStore implements OAuthTokenStore {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly getLogger?: () => Logger,
  ) {}

  load(key: string): Promise<OAuthStoredToken | undefined> {
    return this.enqueue(async () => {
      const file = await this.readFile();
      const token = file.tokens[key];
      return token === undefined ? undefined : copyStoredToken(token);
    });
  }

  save(key: string, token: OAuthStoredToken): Promise<void> {
    return this.enqueue(async () => {
      const file = await this.readFile();
      file.tokens[key] = copyStoredToken(token);
      await this.writeFile(file);
    });
  }

  delete(key: string): Promise<void> {
    return this.enqueue(async () => {
      const file = await this.readFile();
      if (!(key in file.tokens)) {
        return;
      }
      delete file.tokens[key];
      await this.writeFile(file);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      this.logFailure("oauth.token_store_write_failed", error);
      throw new Error("Failed to write the OAuth token store.", { cause: error });
    }
  }

  private logFailure(event: string, error: unknown): void {
    try {
      this.getLogger?.().warn(event, { component: "oauth_token_store", error });
    } catch {
      // Token persistence must not fail because diagnostic logging is unavailable.
    }
  }
}

function parseTokenFile(value: unknown): KanaOAuthTokenFile {
  const file = asRecord(value, "OAuth token store");
  if (file.version !== TOKEN_FILE_VERSION) {
    throw new Error(`OAuth token store version must be ${TOKEN_FILE_VERSION}.`);
  }
  const rawTokens = asRecord(file.tokens, "OAuth token store tokens");
  const tokens: Record<string, OAuthStoredToken> = {};
  for (const [key, rawToken] of Object.entries(rawTokens)) {
    if (!key) {
      throw new Error("OAuth token store keys cannot be empty.");
    }
    tokens[key] = parseStoredToken(rawToken, key);
  }
  return { version: TOKEN_FILE_VERSION, tokens };
}

function parseStoredToken(value: unknown, key: string): OAuthStoredToken {
  const name = `OAuth token ${key}`;
  const token = asRecord(value, name);
  const allowedKeys = new Set([
    "accessToken",
    "tokenType",
    "refreshToken",
    "expiresAt",
    "scopes",
    "issuer",
    "clientId",
    "resource",
  ]);
  const unknownKey = Object.keys(token).find((field) => !allowedKeys.has(field));
  if (unknownKey !== undefined) {
    throw new Error(`${name} contains unknown field ${unknownKey}.`);
  }
  if (token.tokenType !== "Bearer") {
    throw new Error(`${name}.tokenType must be Bearer.`);
  }

  return {
    accessToken: readNonEmptyString(token.accessToken, `${name}.accessToken`),
    tokenType: "Bearer",
    ...readOptionalString(token.refreshToken, "refreshToken", name),
    ...readOptionalExpiresAt(token.expiresAt, name),
    ...readOptionalScopes(token.scopes, name),
    issuer: readNonEmptyString(token.issuer, `${name}.issuer`),
    clientId: readNonEmptyString(token.clientId, `${name}.clientId`),
    ...readOptionalString(token.resource, "resource", name),
  };
}

function readOptionalString<TKey extends "refreshToken" | "resource">(
  value: unknown,
  key: TKey,
  name: string,
): { [K in TKey]?: string } {
  if (value === undefined) {
    return {};
  }
  return { [key]: readNonEmptyString(value, `${name}.${key}`) } as { [K in TKey]?: string };
}

function readOptionalExpiresAt(value: unknown, name: string): { expiresAt?: number } {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name}.expiresAt must be a positive timestamp.`);
  }
  return { expiresAt: value };
}

function readOptionalScopes(value: unknown, name: string): { scopes?: string[] } {
  if (value === undefined) {
    return {};
  }
  if (!Array.isArray(value) || value.some((scope) => typeof scope !== "string" || !scope)) {
    throw new Error(`${name}.scopes must be an array of non-empty strings.`);
  }
  return { scopes: value.slice() as string[] };
}

function readNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function copyStoredToken(token: OAuthStoredToken): OAuthStoredToken {
  return {
    ...token,
    ...(token.scopes === undefined ? {} : { scopes: token.scopes.slice() }),
  };
}

function getOAuthTokenFilePath(env: NodeJS.ProcessEnv | undefined): string {
  return path.join(getKanaConfigPaths(env).home, "oauth-tokens.json");
}

function unauthorizedStatus(): KanaOAuthTokenStatus {
  return { state: "unauthorized", refreshable: false };
}

function tokenStatus(token: OAuthStoredToken, now: number): KanaOAuthTokenStatus {
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
