import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createKanaOAuthTokenStore, loadKanaOAuthTokenStatuses } from "../../../src/kana";
import type { McpOAuthClientRegistration } from "../../../src/mcp";
import type { OAuthStoredToken } from "../../../src/oauth";
import {
  cleanupTempKanaHomes,
  createTempKanaHomeEnv as createTempEnv,
} from "../../helpers/temp-kana-home";

afterEach(cleanupTempKanaHomes);

describe("Kana OAuth token store", () => {
  test("commits verified Codex registration and credentials together while preserving MCP", async () => {
    const env = createTempEnv();
    const store = createKanaOAuthTokenStore({ env });
    await store.save("mcp:existing", token("mcp", 2_000, true));
    const state = {
      hostId: "urn:uuid:host",
      registration: { clientId: "oaiapp_kana", subject: "user" },
    };
    await store.saveOpenAICodexState(state, token("codex", 3_000, true));
    const restored = createKanaOAuthTokenStore({ env });
    expect(await restored.loadOpenAICodexState()).toEqual(state);
    expect((await restored.load("provider:openai-codex"))?.accessToken).toBe("codex-access-token");
    expect((await restored.load("mcp:existing"))?.accessToken).toBe("mcp-access-token");
    expect(statSync(path.join(env.KANA_HOME!, "oauth-tokens.json")).mode & 0o777).toBe(0o600);
    await restored.delete("provider:openai-codex");
    expect(await restored.loadOpenAICodexState()).toEqual(state);
  });
  test("serializes independent stores into a private file and reports safe statuses", async () => {
    const env = createTempEnv();
    const store = createKanaOAuthTokenStore({ env });
    const registration: McpOAuthClientRegistration = {
      issuer: "https://auth.example.com",
      resource: "https://api.example.com/mcp",
      redirectUri: "http://127.0.0.1:12345/oauth/callback",
      client: {
        clientId: "registered-client",
        clientSecret: "registered-secret",
        tokenEndpointAuthMethod: "client_secret_post",
      },
    };
    await Promise.all([
      store.saveClient("mcp:first", registration),
      createKanaOAuthTokenStore({ env }).save("mcp:first", token("first", 2_000, true)),
      createKanaOAuthTokenStore({ env }).save("mcp:second", token("second", 500, false)),
    ]);

    const filePath = path.join(env.KANA_HOME!, "oauth-tokens.json");
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(readFileSync(filePath, "utf8"));
    expect(persisted.version).toBe(1);
    const restoredStore = createKanaOAuthTokenStore({ env });
    expect(await restoredStore.loadClient("mcp:first")).toEqual(registration);
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
    expect(await store.loadClient("mcp:first")).toEqual(registration);
    await store.deleteClient("mcp:first");
    expect(await store.loadClient("mcp:first")).toBeUndefined();
    expect(await store.load("mcp:first")).toBeUndefined();
    expect((await store.load("mcp:second"))?.accessToken).toBe("second-access-token");
  });

  test("preserves rotating Codex tokens during MCP mutations in another process", async () => {
    const env = createTempEnv();
    const state = {
      hostId: "urn:uuid:host",
      registration: { clientId: "oaiapp_kana", subject: "user" },
    };
    const source = `
      import { createKanaOAuthTokenStore } from "./src/kana/auth/token-store.ts";
      const store = createKanaOAuthTokenStore();
      const base = ${JSON.stringify(token("initial", 3_000, true))};
      const state = ${JSON.stringify(state)};
      process.on("message", async () => {
        try {
          for (let i = 0; i < 8; i++) {
            if (process.argv.at(-1) === "codex") {
              await store.withOpenAICodexLock(() => store.saveOpenAICodexState(state, {
                ...base, refreshToken: "rotated-" + i,
              }));
            } else {
              await store.saveClient("mcp:active", {
                issuer: base.issuer, resource: base.resource,
                redirectUri: "http://127.0.0.1:12345/oauth/callback",
                client: { clientId: "mcp-client" },
              });
              await store.save("mcp:active", base);
              await store.save("mcp:temporary", base);
              await store.delete("mcp:temporary");
              await store.saveClient("mcp:temporary", {
                issuer: base.issuer, resource: base.resource,
                redirectUri: "http://127.0.0.1:12345/oauth/callback",
                client: { clientId: "temporary-client" },
              });
              await store.deleteClient("mcp:temporary");
            }
          }
          process.exit(0);
        } catch (error) {
          console.error(error);
          process.exit(1);
        }
      });
      process.send("ready");
    `;
    const workers = ["codex", "mcp"].map((role) => {
      let markReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        markReady = resolve;
      });
      const child = Bun.spawn([process.execPath, "-e", source, role], {
        cwd: path.resolve(import.meta.dir, "../../.."),
        env: { ...process.env, ...env },
        stdout: "ignore",
        stderr: "pipe",
        ipc(message) {
          if (message === "ready") markReady();
        },
      });
      return { child, ready };
    });
    try {
      await Promise.all(workers.map(({ ready }) => ready));
      for (const { child } of workers) child.send("start");
      for (const { child } of workers) {
        expect(await child.exited).toBe(0);
        expect(await new Response(child.stderr).text()).toBe("");
      }
      const store = createKanaOAuthTokenStore({ env });
      expect(await store.loadOpenAICodexState()).toEqual(state);
      expect((await store.load("provider:openai-codex"))?.refreshToken).toBe("rotated-7");
      expect((await store.load("mcp:active"))?.accessToken).toBe("initial-access-token");
      expect((await store.loadClient("mcp:active"))?.client.clientId).toBe("mcp-client");
      expect(await store.load("mcp:temporary")).toBeUndefined();
      expect(await store.loadClient("mcp:temporary")).toBeUndefined();
    } finally {
      for (const { child } of workers) child.kill();
      await Promise.all(workers.map(({ child }) => child.exited));
    }
  });
});

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
