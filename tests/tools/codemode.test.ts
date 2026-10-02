import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { createCodemodeSandbox } from "../../src/tools";
import { createWorkspaceToolFixture } from "./workspace-fixture";

const sandboxes: ReturnType<typeof createCodemodeSandbox>[] = [];
const { createTempRoot, cleanupTempRoots } = createWorkspaceToolFixture();

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.close()));
  await cleanupTempRoots();
});

function createSandbox(options: Parameters<typeof createCodemodeSandbox>[0]) {
  const sandbox = createCodemodeSandbox(options);
  sandboxes.push(sandbox);
  return sandbox;
}

describe("codemode sandbox", () => {
  test("runs asynchronous tools with complete JSON results and isolates host capabilities", async () => {
    const calls: unknown[] = [];
    const sandbox = createSandbox({
      tools: [
        {
          name: "read",
          execute: async (args) => {
            calls.push(args);
            return { entries: ["selected"], payload: "x".repeat(200_000) };
          },
        },
      ],
    });

    const result = await sandbox.execute(`
      const data = await tools.read({ path: "input.json" });
      text(data.entries[0]);
      return {
        bytes: data.payload.length,
        capabilities: [typeof process, typeof Bun, typeof fetch, typeof require, typeof setTimeout]
      };
    `);

    expect(calls).toEqual([{ path: "input.json" }]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        bytes: 200_000,
        capabilities: ["undefined", "undefined", "undefined", "undefined", "undefined"],
      },
      output: [{ type: "text", text: "selected" }],
      calls: [{ name: "read", status: "ok" }],
    });
  });

  test.each(["while (true) {}", "while (true) await null"])(
    "terminates a runaway script without blocking the host (%s)",
    async (code) => {
      const sandbox = createSandbox({ tools: [], timeoutMs: 200 });

      expect(await sandbox.execute(code)).toMatchObject({
        ok: false,
        error: { kind: "timeout" },
      });
    },
  );

  test("passes caller cancellation through to pending host tools", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const sandbox = createSandbox({
      tools: [
        {
          name: "wait",
          execute: (_args, { signal }) => {
            receivedSignal = signal;
            markStarted();
            return new Promise((resolve) => {
              signal.addEventListener("abort", () => resolve("stopped"), { once: true });
            });
          },
        },
      ],
    });

    const pending = sandbox.execute("await tools.wait({})", { signal: controller.signal });
    await started;
    controller.abort();

    expect(await pending).toMatchObject({
      ok: false,
      error: { kind: "aborted" },
      calls: [{ name: "wait", status: "cancelled" }],
    });
    expect(receivedSignal?.aborted).toBe(true);
  });

  test("enforces the configured 256 MiB heap limit", async () => {
    const sandbox = createSandbox({ tools: [] });

    const result = await sandbox.execute(`
      try {
        return new ArrayBuffer(512 * 1024 * 1024).byteLength;
      } catch (error) {
        return error.message;
      }
    `);

    expect(result).toMatchObject({ ok: true, value: expect.stringContaining("memory") });
  });

  test("runs an embedded worker and WASM from a compiled executable in another directory", async () => {
    const root = await createTempRoot();
    const projectRoot = path.resolve(import.meta.dir, "../..");
    const binary = path.join(root, "codemode-fixture");
    const build = await Bun.build({
      root: projectRoot,
      entrypoints: [
        path.join(projectRoot, "tests/fixtures/codemode-sandbox.ts"),
        path.join(projectRoot, "src/tools/codemode/worker.ts"),
        path.join(projectRoot, "node_modules/quickjs-wasi/quickjs.wasm"),
      ],
      compile: { outfile: binary },
    });
    expect(build.success).toBe(true);
    const process = Bun.spawn([binary], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      value: { value: 42, process: "undefined" },
      output: [{ type: "text", text: "42" }],
      calls: [{ name: "echo", status: "ok" }],
    });
  }, 30_000);
});
