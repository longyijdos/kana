import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { Type } from "typebox";
import { ToolRuntime } from "../../src/agent/tool-runtime";
import { createCodemodeSandbox, createCodemodeTool, type Tool } from "../../src/tools";
import { createWorkspaceToolFixture, expectToolResult } from "./workspace-fixture";

const sandboxes: ReturnType<typeof createCodemodeSandbox>[] = [];
const { createTempRoot, cleanupTempRoots } = createWorkspaceToolFixture();

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.close()));
  await cleanupTempRoots();
});

describe("codemode tool", () => {
  const parameters = Type.Object({});
  const canonicalResult = { payload: "x".repeat(200_000) };
  const read = {
    name: "read",
    description: "Return a complete result.",
    parameters,
    execute: () => ({ content: "formatted preview", result: canonicalResult }),
  } satisfies Tool<typeof parameters, typeof canonicalResult>;

  test("uses complete results through approval and commits only the script output", async () => {
    const approvals: string[] = [];
    const completions: string[] = [];
    const commits: string[] = [];
    const codemode = createCodemodeTool({ tools: [read] });
    const runtime = new ToolRuntime(
      {
        tools: [codemode, read],
        beforeToolExecution: ({ tool }) => {
          approvals.push(tool.name);
          return { type: "continue" };
        },
        onMessageCommitted: (message) => {
          if (message.role === "tool") commits.push(message.toolName);
        },
      },
      (event) => {
        if (event.type === "tool_execution_end") completions.push(event.toolName);
      },
    );
    const execution = await runtime.execute([
      {
        type: "tool_call",
        id: "code",
        name: "run_code",
        args: {
          code: 'const data = await tools.read({}); text("selected"); return data.payload.length;',
        },
      },
    ]);

    expect(approvals).toEqual(["run_code", "read"]);
    expect(completions).toEqual(["read", "run_code"]);
    expect(commits).toEqual(["run_code"]);
    expect(execution.toolResults).toHaveLength(1);
    expect(execution.toolResults[0]).toMatchObject({
      content: "selected\n200000",
      isError: false,
      result: { ok: true, value: 200_000, calls: [{ name: "read", status: "ok" }] },
    });
  });

  test("maps native output, images, store writes, and catchable tool failures", async () => {
    const codemode = createCodemodeTool({ tools: [read, { ...read, name: "run_code" }] });
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const result = await codemode.execute(
      {
        code: `
          try { await tools.read({}); } catch (error) { text(error.message); }
          image("data:image/png;base64,${png}");
          store("key", { value: 1 });
          return { value: load("key"), nestedCodemode: "run_code" in tools };
        `,
      },
      {
        toolCallId: "code",
        update() {},
        invokeTool: async () => ({ content: "operation failed", result: {}, isError: true }),
      },
    );
    expectToolResult(result);
    expect(result.content).toBe('operation failed\n{"value":{"value":1},"nestedCodemode":false}');
    expect(result.images).toEqual([{ data: png, mimeType: "image/png", width: 1, height: 1 }]);
    expect(result.result).toMatchObject({
      ok: true,
      calls: [{ name: "read", status: "error" }],
      storeWrites: { set: { key: { value: 1 } }, delete: [] },
    });
  });

  test("retains output before a script error", async () => {
    const codemode = createCodemodeTool({ tools: [] });
    const result = await codemode.execute(
      { code: 'text("before"); throw new Error("script failed");' },
      { toolCallId: "code", update() {}, invokeTool: async () => read.execute() },
    );
    expectToolResult(result);
    expect(result.content).toContain("before\nError: script failed");
    expect(result.isError).toBe(true);
    expect(result.result).toMatchObject({ ok: false, error: { kind: "script" } });
  });

  test("approval denial aborts the script even when its code catches tool errors", async () => {
    let afterCount = 0;
    const after = {
      ...read,
      name: "after",
      execute: () => {
        afterCount += 1;
        return "unexpected";
      },
    };
    const codemode = createCodemodeTool({ tools: [read, after] });
    const runtime = new ToolRuntime(
      {
        tools: [codemode, read, after],
        beforeToolExecution: ({ tool }) =>
          tool.name === "read"
            ? { type: "cancel", message: "Approval denied." }
            : { type: "continue" },
      },
      () => {},
    );
    const result = await runtime.execute([
      {
        type: "tool_call",
        id: "code",
        name: "run_code",
        args: { code: "try { await tools.read({}); } catch {} await tools.after({});" },
      },
      { type: "tool_call", id: "after", name: "after", args: {} },
    ]);
    expect(result.abortRun).toBe(true);
    expect(result.toolResults.map((message) => message.isError)).toEqual([true, true]);
    expect(afterCount).toBe(0);
  });

  test("the Agent deadline terminates a running script", async () => {
    let started = false;
    const ready = {
      ...read,
      name: "ready",
      execute: () => {
        started = true;
        return true;
      },
    };
    const codemode = createCodemodeTool({ tools: [ready] });
    const runtime = new ToolRuntime({ tools: [codemode, ready], defaultDeadlineMs: 200 }, () => {});
    const result = await runtime.execute([
      {
        type: "tool_call",
        id: "code",
        name: "run_code",
        args: { code: "await tools.ready({}); while (true) {}" },
      },
    ]);
    expect(started).toBe(true);
    expect(result.abortRun).toBe(true);
    expect(result.toolResults[0]).toMatchObject({ isError: true, result: { status: "timed_out" } });
  });
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
