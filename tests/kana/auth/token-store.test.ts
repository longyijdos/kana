import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKanaOAuthTokenStore, loadKanaOAuthTokenStatuses } from "../../../src/kana";
import type { OAuthStoredToken } from "../../../src/oauth";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Kana OAuth token store", () => {
  test("serializes token updates into a private file and reports safe statuses", async () => {
    const env = createTempEnv();
    const store = createKanaOAuthTokenStore({ env });
    await Promise.all([
      store.save("mcp:first", token("first", 2_000, true)),
      store.save("mcp:second", token("second", 500, false)),
    ]);

    const filePath = path.join(env.KANA_HOME!, "oauth-tokens.json");
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(readFileSync(filePath, "utf8"));
    expect(persisted.version).toBe(1);
    expect(Object.keys(persisted.tokens).sort()).toEqual(["mcp:first", "mcp:second"]);
    expect(
      loadKanaOAuthTokenStatuses(["mcp:first", "mcp:second", "mcp:missing"], {
        env,
        now: () => 1_000,
      }),
    ).toEqual({
      "mcp:first": { state: "authorized", refreshable: true, expiresAt: 2_000 },
      "mcp:second": { state: "expired", refreshable: false, expiresAt: 500 },
      "mcp:missing": { state: "unauthorized", refreshable: false },
    });

    await store.delete("mcp:first");
    expect(await store.load("mcp:first")).toBeUndefined();
    expect((await store.load("mcp:second"))?.accessToken).toBe("second-access-token");
  });
});

function createTempEnv(): NodeJS.ProcessEnv {
  const directory = mkdtempSync(path.join(tmpdir(), "kana-oauth-store-"));
  tempDirs.push(directory);
  return { KANA_HOME: path.join(directory, ".kana") };
}

function token(name: string, expiresAt: number, refreshable: boolean): OAuthStoredToken {
  return {
    accessToken: `${name}-access-token`,
    tokenType: "Bearer",
    ...(refreshable ? { refreshToken: `${name}-refresh-token` } : {}),
    expiresAt,
    scopes: ["read"],
    issuer: "https://auth.example.com",
    clientId: "kana-client",
    resource: "https://api.example.com/mcp",
  };
}
