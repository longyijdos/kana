import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitFor } from "../helpers/async-control";
import { cleanupTempKanaHomes, createTempKanaHomeEnv } from "../helpers/temp-kana-home";

const main = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
afterAll(cleanupTempKanaHomes);

describe("server process", () => {
  test("refuses startup without a token before creating product resources", async () => {
    const env = createTempKanaHomeEnv();
    const child = Bun.spawn([process.execPath, main, "serve"], {
      env: { ...process.env, ...env, KANA_SERVER_TOKEN: "" },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("KANA_SERVER_TOKEN is required");
    expect(await Bun.file(path.join(env.KANA_HOME, "config.toml")).exists()).toBe(false);
  });

  test("runs through the real CLI/provider, shuts down cleanly, and starts a fresh session on restart", async () => {
    const env = createTempKanaHomeEnv();
    const token = crypto.randomUUID();
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          [
            'data: {"id":"local-test","choices":[{"index":0,"delta":{"role":"assistant","content":"Local answer."},"finish_reason":null}]}',
            'data: {"id":"local-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    await Bun.write(
      path.join(env.KANA_HOME, "providers", "custom.toml"),
      `base_url = "http://127.0.0.1:${provider.port}/v1"
max_retries = 0
[[models]]
name = "local-test"
context_window = 32000
max_output_tokens = 4096
supports_parallel_tool_calls = false
supports_image_input = false
reasoning_efforts = ["none"]
default_reasoning_effort = "none"
`,
    );
    await Bun.write(
      path.join(env.KANA_HOME, "config.toml"),
      `[agent]
tools = []
[agent.model]
provider = "custom"
name = "local-test"
[memory.agent.model]
provider = "custom"
name = "local-test"
`,
    );
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port!;
    await reservation.stop(true);
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let output = "";
    let outputDone: Promise<void> | undefined;
    async function start() {
      output = "";
      child = Bun.spawn([process.execPath, main, "serve", "--port", String(port)], {
        cwd: env.KANA_HOME,
        env: {
          ...process.env,
          ...env,
          KANA_SERVER_TOKEN: token,
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          ALL_PROXY: "",
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      const stderr = child.stderr as ReadableStream<Uint8Array>;
      outputDone = (async () => {
        const reader = stderr.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          output += decoder.decode(chunk.value, { stream: true });
        }
      })();
      await waitFor(() => output.includes("Kana API listening") || child!.exitCode !== null, 5_000);
      if (child.exitCode !== null) throw new Error(output);
    }
    async function request(route: string, method = "GET", body?: unknown) {
      return fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    async function stop() {
      child?.kill("SIGTERM");
      expect(await child?.exited).toBe(0);
      await outputDone;
      expect(output).not.toContain(token);
      child = undefined;
    }
    try {
      await start();
      expect((await fetch(`http://127.0.0.1:${port}/v1/state`)).status).toBe(401);
      const initial = await (await request("/v1/state")).json();
      const originalId = initial.data.session.id;
      expect(
        (await request("/v1/messages", "POST", { session_id: originalId, message: "Say hello" }))
          .status,
      ).toBe(202);
      let state = initial;
      for (let attempt = 0; attempt < 100; attempt++) {
        state = await (await request("/v1/state")).json();
        if (state.data.run?.status === "completed" && !state.data.running) break;
        await Bun.sleep(5);
      }
      expect(state.data.run).toMatchObject({ status: "completed", outcome: "stop" });
      expect(state.data.session.messages.at(-1).content).toEqual([
        { type: "text", text: "Local answer." },
      ]);
      await stop();
      await start();
      const restarted = await (await request("/v1/state")).json();
      expect(restarted.data.session.id).not.toBe(originalId);
      expect(restarted.data.session.messages).toEqual([]);
      expect((await request(`/v1/sessions/${originalId}/resume`, "POST")).status).toBe(200);
      const resumed = await (await request("/v1/state")).json();
      expect(resumed.data.session.id).toBe(originalId);
      expect(resumed.data.session.messages.at(-1).content).toEqual([
        { type: "text", text: "Local answer." },
      ]);
      expect(
        resumed.data.session.timeline.filter((entry: { type: string }) => entry.type === "message"),
      ).toEqual(
        resumed.data.session.messages.map((message: { id: string }) =>
          expect.objectContaining({ type: "message", message_id: message.id }),
        ),
      );
      expect(resumed.data.session.timeline).not.toContainEqual(
        expect.objectContaining({ message: expect.anything() }),
      );
      await stop();
    } finally {
      if (child) {
        child.kill("SIGKILL");
        await child.exited;
      }
      await outputDone;
      await provider.stop(true);
    }
  }, 15_000);
});
