import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createShellTool } from "../../src/tools/shell";
import { validateToolArguments } from "../../src/tools/validation";
import {
  createToolContext,
  createWorkspaceToolFixture,
  expectToolResult,
} from "./workspace-fixture";

const { cleanupTempRoots, createTempRoot } = createWorkspaceToolFixture();

describe("shell tool", () => {
  afterEach(cleanupTempRoots);

  test("bounds command timeouts inside its own execution deadline", () => {
    const shell = createShellTool();
    const deadlineMs = shell.execution?.deadlineMs;

    expect(deadlineMs).toBe(301_000);
    expect(() => validateToolArguments(shell, { command: "echo hi", timeoutMs: 301_000 })).toThrow(
      "must be <= 300000",
    );
    expect(validateToolArguments(shell, { command: "echo hi", timeoutMs: 300_000 })).toMatchObject({
      timeoutMs: 300_000,
    });
  });

  test("runs a command inside the workspace", async () => {
    const root = await createTempRoot();
    await writeFile(path.join(root, "notes.txt"), "hello\n");
    const shell = createShellTool({ root });
    const result = await shell.execute(
      {
        command: "cat notes.txt",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toEqual({
      exitCode: 0,
      stdout: "hello\n",
      stderr: "",
      timedOut: false,
    });
    expect(result.content).toBe("exitCode: 0\ntimedOut: false\n\nstdout:\nhello\n\n\nstderr:\n");
    expect(result.isError).toBe(false);
  });

  test("preserves non-zero command exits without marking the tool as an error", async () => {
    const root = await createTempRoot();
    const shell = createShellTool({ root });
    const result = await shell.execute(
      {
        command: "printf command-failed >&2; exit 7",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      exitCode: 7,
      stderr: "command-failed",
      timedOut: false,
    });
    expect(result.isError).toBe(false);
  });

  test("streams stdout before the command completes", async () => {
    const root = await createTempRoot();
    const updates: unknown[] = [];
    const shell = createShellTool({ root });
    let completed = false;
    const execution = Promise.resolve(
      shell.execute(
        {
          command: "printf start; sleep 1; printf end",
        },
        createToolContext(updates),
      ),
    ).finally(() => {
      completed = true;
    });

    await waitForCondition(() => updates.length > 0);

    expect(completed).toBe(false);
    expect(updates[0]).toEqual({
      stdout: "start",
      stderr: "",
    });

    const result = await execution;

    expectToolResult(result);
    expect(result.result).toMatchObject({
      exitCode: 0,
      stdout: "startend",
    });
  });

  test("streams stderr output", async () => {
    const root = await createTempRoot();
    const updates: unknown[] = [];
    const shell = createShellTool({ root });
    const result = await shell.execute(
      {
        command: "printf problem >&2",
      },
      createToolContext(updates),
    );

    expectToolResult(result);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.at(-1)).toMatchObject({
      stderr: "problem",
    });
  });

  test("preserves complete final output and bounds live updates to a trailing snapshot", async () => {
    const root = await createTempRoot();
    const updates: unknown[] = [];
    const shell = createShellTool({ root });
    const fullStdout = `prefix-${"x".repeat(25_000)}-suffix`;
    const result = await shell.execute(
      {
        command: `printf %s ${shellQuote(fullStdout)}`,
      },
      createToolContext(updates),
    );

    expectToolResult(result);
    expect(result.result.stdout).toBe(fullStdout);
    expect(result.result).not.toHaveProperty("stdoutTruncated");
    expect(result.result).not.toHaveProperty("stderrTruncated");
    expect(updates.at(-1)).toMatchObject({
      stdout: fullStdout.slice(-20_000),
    });
    expect(updates.at(-1)).not.toHaveProperty("stdoutTruncated");
    expect(updates.at(-1)).not.toHaveProperty("stderrTruncated");
  });

  test("runs commands with stdin disconnected", async () => {
    const root = await createTempRoot();
    const shell = createShellTool({ root });
    const result = await shell.execute(
      {
        command: 'if read -t 1 value; then printf "read:%s" "$value"; else printf no-stdin; fi',
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      exitCode: 0,
      stdout: "no-stdin",
    });
  });

  test("makes sudo non-interactive by default", async () => {
    const root = await createTempRoot();
    const sudoPath = path.join(root, "sudo");
    await writeFile(
      sudoPath,
      ["#!/usr/bin/env bash", 'printf "%s\\n" "$@" > sudo-args.txt', "printf fake-sudo", ""].join(
        "\n",
      ),
    );
    await chmod(sudoPath, 0o755);
    const shell = createShellTool({ root });
    const result = await shell.execute(
      {
        command: `PATH=${shellQuote(root)}:$PATH sudo id`,
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      exitCode: 0,
      stdout: "fake-sudo",
    });
    expect(await readFile(path.join(root, "sudo-args.txt"), "utf8")).toBe("-n\nid\n");
  });

  test("can run commands through a configured shell", async () => {
    const root = await createTempRoot();
    const shellPath = path.join(root, "bash");
    await writeFile(
      shellPath,
      [
        "#!/usr/bin/env bash",
        "export KANA_CUSTOM_SHELL=from-custom-shell",
        'exec bash "$@"',
        "",
      ].join("\n"),
    );
    await chmod(shellPath, 0o755);
    const shell = createShellTool({ root, shell: shellPath });
    const result = await shell.execute(
      {
        command: 'printf %s "$KANA_CUSTOM_SHELL"',
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      exitCode: 0,
      stdout: "from-custom-shell",
    });
  });

  test("runs with bash when SHELL selects an unsupported interpreter", async () => {
    const root = await createTempRoot();
    const previousShell = process.env.SHELL;
    try {
      process.env.SHELL = "/usr/bin/fish";
      const shell = createShellTool({ root });
      const result = await shell.execute(
        { command: 'printf %s "$BASH_VERSION"' },
        createToolContext(),
      );

      expectToolResult(result);
      expect(result.result.exitCode).toBe(0);
      expect(result.result.stdout).toMatch(/^\d+\./);
      expect(result.isError).toBe(false);
    } finally {
      if (previousShell === undefined) {
        delete process.env.SHELL;
      } else {
        process.env.SHELL = previousShell;
      }
    }
  });

  test("inherits environment variables added after process startup", async () => {
    const root = await createTempRoot();
    const envName = `KANA_TEST_SHELL_RUNTIME_${process.pid}`;
    const previous = process.env[envName];
    process.env[envName] = "from-runtime";

    try {
      const shell = createShellTool({ root });
      const result = await shell.execute(
        {
          command: `printf %s "$${envName}"`,
        },
        createToolContext(),
      );

      expectToolResult(result);
      expect(result.result).toMatchObject({
        exitCode: 0,
        stdout: "from-runtime",
      });
    } finally {
      if (previous === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = previous;
      }
    }
  });

  test("runs from a workspace subdirectory", async () => {
    const root = await createTempRoot();
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "notes.txt"), "hello\n");
    const shell = createShellTool({ root });
    const result = await shell.execute(
      {
        command: "cat notes.txt",
        cwd: "src",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      stdout: "hello\n",
    });
  });

  test("allows shell control operators", async () => {
    const root = await createTempRoot();
    await writeFile(path.join(root, "notes.txt"), "hello\n");
    const shell = createShellTool({ root });
    const result = await shell.execute(
      {
        command: "cat notes.txt; printf done",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      exitCode: 0,
      stdout: "hello\ndone",
    });
  });

  test("allows arbitrary commands", async () => {
    const root = await createTempRoot();
    const filePath = path.join(root, "notes.txt");
    await writeFile(filePath, "hello\n");
    const shell = createShellTool({ root });
    const result = await shell.execute(
      {
        command: "rm notes.txt",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      exitCode: 0,
    });
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
  });

  test("allows git history-changing commands", async () => {
    const root = await createTempRoot();
    const shell = createShellTool({ root });
    const result = await shell.execute(
      {
        command: "git reset --hard",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      exitCode: 128,
      timedOut: false,
    });
    expect(result.isError).toBe(false);
  });

  test("accepts cwd outside the workspace", async () => {
    const root = await createTempRoot();
    const outside = await createTempRoot();
    await writeFile(path.join(outside, "notes.txt"), "outside\n");
    const shell = createShellTool({ root });
    const result = await shell.execute(
      {
        command: "cat notes.txt",
        cwd: outside,
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      stdout: "outside\n",
    });
  });

  test("keeps raw shell backgrounding inside the foreground process lifetime", async () => {
    const root = await createTempRoot();
    const sideEffectPath = path.join(root, "escaped.txt");
    const sideEffectDelaySeconds = 1;
    const shell = createShellTool({ root });
    const result = await shell.execute(
      {
        command: `(sleep ${sideEffectDelaySeconds}; printf escaped > ${shellQuote(sideEffectPath)}) & printf foreground`,
        timeoutMs: 100,
      },
      createToolContext(),
    );
    expectToolResult(result);

    expect(result.result).toMatchObject({
      exitCode: null,
      timedOut: true,
    });
    await new Promise((resolve) => setTimeout(resolve, sideEffectDelaySeconds * 1_000 + 100));
    expect(existsSync(sideEffectPath)).toBe(false);
  });

  test("cancellation terminates background children in the command process group", async () => {
    const root = await createTempRoot();
    const pidPath = path.join(root, "background.pid");
    const shell = createShellTool({ root });
    const controller = new AbortController();
    const execution = shell.execute(
      {
        command: `sleep 30 & printf %s "$!" > ${shellQuote(pidPath)}; wait`,
      },
      {
        ...createToolContext(),
        signal: controller.signal,
      },
    );

    await waitForCondition(() => existsSync(pidPath));
    controller.abort();

    await expect(execution).rejects.toThrow("Command aborted.");
    const pid = Number(await readFile(pidPath, "utf8"));
    await waitForCondition(() => !isProcessRunning(pid));
  });

  test("reports timeouts", async () => {
    const root = await createTempRoot();
    const shell = createShellTool({ root });
    const result = await shell.execute(
      {
        command: "find .",
        timeoutMs: 1,
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      exitCode: null,
      timedOut: true,
    });
    expect(result.isError).toBe(true);
  });
});

async function waitForCondition(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for condition.");
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
