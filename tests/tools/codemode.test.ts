import { afterEach, describe, expect, spyOn, test } from "bun:test";
import path from "node:path";
import { Type } from "typebox";
import { ToolRuntime } from "../../src/agent/tool-runtime";
import {
  createCodemodeSandbox,
  createCodemodeTool,
  createShellTool,
  type Tool,
} from "../../src/tools";
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

  test("renders output types in mixed mode and complete declarations in only mode", () => {
    const tool = {
      ...read,
      parameters: Type.Object({ path: Type.String() }),
      outputSchema: Type.Object({ payload: Type.String() }),
    };
    const unknown = { ...read, name: "custom" };
    const mixed = createCodemodeTool({ tools: [tool, unknown] });
    const only = createCodemodeTool({ tools: [tool, unknown], mode: "only" });

    expect(mixed.description).toContain("read: { payload: string; };");
    expect(mixed.description).toContain("custom: unknown;");
    expect(mixed.description).not.toContain(tool.description);
    expect(mixed.description).not.toContain("path: string");
    expect(only.description).toContain(tool.description);
    expect(only.description).toContain(
      "read(args: { path: string; }): Promise<{ payload: string; }>;",
    );
    expect(only.description).toContain(
      "custom(args: { [key: string]: unknown; }): Promise<unknown>;",
    );
  });

  test("uses complete results through approval and commits only the script output", async () => {
    const approvals: string[] = [];
    const completions: string[] = [];
    const commits: string[] = [];
    const codemode = createCodemodeTool({ tools: [read] });
    const runtime = new ToolRuntime(
      {
        tools: [codemode],
        callableTools: [read],
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

    const direct = await runtime.execute([
      { type: "tool_call", id: "hidden", name: "read", args: {} },
    ]);
    expect(direct.toolResults[0]).toMatchObject({
      isError: true,
      result: { error: 'Tool "read" not found' },
    });
  });

  test("exposes the shell outcome through its declarations and script return value", async () => {
    const shell = createShellTool({ root: await createTempRoot() });
    const codemode = createCodemodeTool({ tools: [shell] });
    expect(codemode.description).toContain("shell: { exitCode:");
    expect(codemode.description).not.toContain("command:");
    expect(codemode.description).not.toContain("cwd:");
    const runtime = new ToolRuntime({ tools: [codemode], callableTools: [shell] }, () => {});
    const execution = await runtime.execute([
      {
        type: "tool_call",
        id: "code",
        name: "run_code",
        args: { code: 'return await tools.shell({ command: "printf clean" });' },
      },
    ]);
    expect(execution.toolResults[0]).toMatchObject({
      isError: false,
      result: {
        ok: true,
        value: { exitCode: 0, stdout: "clean", stderr: "", timedOut: false },
        calls: [{ name: "shell", status: "ok" }],
      },
    });
    const outcome = JSON.parse(execution.toolResults[0]!.content);
    expect(Object.keys(outcome).sort()).toEqual(["exitCode", "stderr", "stdout", "timedOut"]);
  });

  test("forwards tool images while scripts receive only the structured result", async () => {
    const image = {
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      mimeType: "image/png" as const,
      width: 1,
      height: 1,
    };
    const codemode = createCodemodeTool({ tools: [{ ...read, name: "view_image" }], mode: "only" });
    const result = await codemode.execute(
      { code: "return await tools.view_image({});" },
      {
        toolCallId: "code",
        update() {},
        invokeTool: async () => ({
          content: "image metadata",
          result: { width: 1 },
          images: [image],
        }),
      },
    );
    expect(result.content).toBe('{"width":1}');
    expect(result.images).toEqual([image]);
    expect(result.result).toMatchObject({ ok: true, value: { width: 1 } });
  });

  test("matches runtime durations to concurrent calls to the same tool", async () => {
    let finishFirst: (() => void) | undefined;
    const completed: string[] = [];
    const codemode = createCodemodeTool({ tools: [read] });
    const result = await codemode.execute(
      {
        code: 'return await Promise.all([tools.read({ label: "a" }), tools.read({ label: "b" })]);',
      },
      {
        toolCallId: "code",
        update() {},
        invokeTool: (_name, args, options) => {
          const label = (args as { label: string }).label;
          if (label === "a") {
            return new Promise((resolve) => {
              finishFirst = () => {
                completed.push(label);
                options!.onExecutionEnd!(11.5);
                resolve({ content: label, result: label });
              };
            });
          }
          completed.push(label);
          options!.onExecutionEnd!(22.5);
          setTimeout(() => finishFirst!(), 5);
          return Promise.resolve({ content: label, result: label });
        },
      },
    );
    expect(completed).toEqual(["b", "a"]);
    expect(result.result).toMatchObject({
      ok: true,
      value: ["a", "b"],
      calls: [
        { name: "read", status: "ok", durationMs: 11.5 },
        { name: "read", status: "ok", durationMs: 22.5 },
      ],
    });
  });

  test("preserves execution duration when the script cancels an unawaited tool", async () => {
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const slow = {
      name: "slow",
      description: "Wait for cancellation.",
      parameters,
      execution: { concurrency: "parallel" },
      execute: (_args, { signal }) =>
        new Promise((resolve) => {
          signal!.addEventListener("abort", () => resolve("stopped"), { once: true });
        }),
    } satisfies Tool;
    const finish = {
      name: "finish",
      description: "Finish the script.",
      parameters,
      execution: { concurrency: "parallel" },
      execute: () => {
        now = 25;
        return "done";
      },
    } satisfies Tool;
    const codemode = createCodemodeTool({ tools: [slow, finish] });
    const runtime = new ToolRuntime({ tools: [codemode], callableTools: [slow, finish] }, () => {});
    try {
      const execution = await runtime.execute([
        {
          type: "tool_call",
          id: "code",
          name: "run_code",
          args: { code: 'tools.slow({}); await tools.finish({}); return "done";' },
        },
      ]);
      expect(execution.toolResults[0]).toMatchObject({
        durationMs: 25,
        isError: false,
        result: {
          ok: true,
          calls: [
            { name: "slow", status: "cancelled", durationMs: 25 },
            { name: "finish", status: "ok", durationMs: 25 },
          ],
        },
      });
    } finally {
      clock.mockRestore();
    }
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
        invokeTool: async (_name, _args, options) => {
          options!.onExecutionEnd!(12.5);
          return { content: "operation failed", result: {}, isError: true };
        },
      },
    );
    expectToolResult(result);
    expect(result.content).toBe('operation failed\n{"value":{"value":1},"nestedCodemode":false}');
    expect(result.images).toEqual([{ data: png, mimeType: "image/png", width: 1, height: 1 }]);
    expect(result.result).toMatchObject({
      ok: true,
      calls: [{ name: "read", status: "error", durationMs: 12.5 }],
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

  test("owns a 15-minute deadline and terminates a running script through the runtime", async () => {
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
    expect(codemode.execution.deadlineMs).toBe(900_000);
    codemode.execution.deadlineMs = 200;
    const runtime = new ToolRuntime(
      { tools: [codemode, ready], defaultDeadlineMs: 1_000 },
      () => {},
    );
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
    expect(result.toolResults[0]).toMatchObject({
      isError: true,
      result: { status: "timed_out", deadlineMs: 200 },
    });
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
