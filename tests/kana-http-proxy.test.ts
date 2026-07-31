import { describe, expect, test } from "bun:test";
import { createHttpProxyFetch } from "../src/kana/mcp/http-proxy";
import type { OAuthFetch } from "../src/oauth";

describe("Kana HTTP proxy routing", () => {
  test("restores process proxy bypass state before another MCP request starts", async () => {
    const previousUpper = process.env.NO_PROXY;
    const previousLower = process.env.no_proxy;
    const observations: Array<{
      hostname: string;
      noProxy: string | undefined;
      lowerNoProxy: string | undefined;
      proxy?: unknown;
    }> = [];
    let finishDirect: ((response: Response) => void) | undefined;
    const fetch: OAuthFetch = (input, init) => {
      const request = new Request(input, init);
      observations.push({
        hostname: new URL(request.url).hostname,
        noProxy: process.env.NO_PROXY,
        lowerNoProxy: process.env.no_proxy,
        proxy: (init as (RequestInit & { proxy?: unknown }) | undefined)?.proxy,
      });
      if (request.url === "https://direct.example/mcp") {
        return new Promise((resolve) => {
          finishDirect = resolve;
        });
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    };

    process.env.NO_PROXY = "existing.example";
    delete process.env.no_proxy;
    try {
      const directRequest = createHttpProxyFetch(false, fetch)("https://direct.example/mcp");

      expect(process.env.NO_PROXY).toBe("existing.example");
      expect(process.env.no_proxy).toBeUndefined();

      const proxiedRequest = createHttpProxyFetch(
        "http://proxy.example:8080",
        fetch,
      )("https://proxied.example/mcp");
      finishDirect?.(new Response(null, { status: 200 }));
      await Promise.all([directRequest, proxiedRequest]);

      expect(observations).toEqual([
        {
          hostname: "direct.example",
          noProxy: "existing.example,direct.example",
          lowerNoProxy: "direct.example",
          proxy: undefined,
        },
        {
          hostname: "proxied.example",
          noProxy: "existing.example",
          lowerNoProxy: undefined,
          proxy: "http://proxy.example:8080",
        },
      ]);
    } finally {
      restoreEnvironment("NO_PROXY", previousUpper);
      restoreEnvironment("no_proxy", previousLower);
    }
  });

  test("restores process state when the underlying fetch throws synchronously", () => {
    const previousUpper = process.env.NO_PROXY;
    const previousLower = process.env.no_proxy;
    process.env.NO_PROXY = "before.example";
    process.env.no_proxy = "lower-before.example";
    try {
      const fetch = (() => {
        throw new Error("fetch failed");
      }) as OAuthFetch;

      expect(() => createHttpProxyFetch(false, fetch)("https://direct.example/mcp")).toThrow(
        "fetch failed",
      );
      expect(process.env.NO_PROXY).toBe("before.example");
      expect(process.env.no_proxy).toBe("lower-before.example");
    } finally {
      restoreEnvironment("NO_PROXY", previousUpper);
      restoreEnvironment("no_proxy", previousLower);
    }
  });
});

function restoreEnvironment(name: "NO_PROXY" | "no_proxy", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
