import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BackgroundJobManager } from "../../src/jobs";
import { createBashTool } from "../../src/tools/bash";
import {
  createToolContext,
  createWorkspaceToolFixture,
  expectToolResult,
} from "./workspace-fixture";

const { cleanupTempRoots, createTempRoot } = createWorkspaceToolFixture();

describe("bash tool", () => {
  afterEach(cleanupTempRoots);

  test("keeps shell fallback guidance in the bash tool description", () => {
    expect(createBashTool().description).toContain("no purpose-built tool directly covers");
  });

  test("runs a command inside the workspace", async () => {
    const root = await createTempRoot();
    await writeFile(path.join(root, "notes.txt"), "hello\n");
    const bash = createBashTool({ root });
    const result = await bash.execute(
      {
        command: "cat notes.txt",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      command: "cat notes.txt",
      cwd: ".",
      exitCode: 0,
      stdout: "hello\n",
      stderr: "",
      timedOut: false,
    });
    expect(result.isError).toBe(false);
  });

  test("preserves non-zero command exits without marking the tool as an error", async () => {
    const root = await createTempRoot();
    const bash = createBashTool({ root });
    const result = await bash.execute(
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
    const bash = createBashTool({ root });
    let completed = false;
    const execution = Promise.resolve(
      bash.execute(
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
    expect(updates[0]).toMatchObject({
      command: "printf start; sleep 1; printf end",
      cwd: ".",
      stdout: "start",
      stderr: "",
    });
    expect(updates[0]).not.toHaveProperty("exitCode");

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
    const bash = createBashTool({ root });
    const result = await bash.execute(
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
    const bash = createBashTool({ root });
    const fullStdout = `prefix-${"x".repeat(25_000)}-suffix`;
    const result = await bash.execute(
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
    const bash = createBashTool({ root });
    const result = await bash.execute(
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
    const bash = createBashTool({ root });
    const result = await bash.execute(
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
    const shellPath = path.join(root, "custom-shell");
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
    const bash = createBashTool({ root, shell: shellPath });
    const result = await bash.execute(
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

  test("inherits environment variables added after process startup", async () => {
    const root = await createTempRoot();
    const envName = `KANA_TEST_BASH_RUNTIME_${process.pid}`;
    const previous = process.env[envName];
    process.env[envName] = "from-runtime";

    try {
      const bash = createBashTool({ root });
      const result = await bash.execute(
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
    const bash = createBashTool({ root });
    const result = await bash.execute(
      {
        command: "cat notes.txt",
        cwd: "src",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      cwd: "src",
      stdout: "hello\n",
    });
  });

  test("allows shell control operators", async () => {
    const root = await createTempRoot();
    await writeFile(path.join(root, "notes.txt"), "hello\n");
    const bash = createBashTool({ root });
    const result = await bash.execute(
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
    const bash = createBashTool({ root });
    const result = await bash.execute(
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
    const bash = createBashTool({ root });
    const result = await bash.execute(
      {
        command: "git reset --hard",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      command: "git reset --hard",
    });
  });

  test("accepts cwd outside the workspace", async () => {
    const root = await createTempRoot();
    const outside = await createTempRoot();
    await writeFile(path.join(outside, "notes.txt"), "outside\n");
    const bash = createBashTool({ root });
    const result = await bash.execute(
      {
        command: "cat notes.txt",
        cwd: outside,
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      cwd: path.relative(root, outside),
      stdout: "outside\n",
    });
  });

  test("starts a session-owned background Job and streams its output separately", async () => {
    const root = await createTempRoot();
    const manager = new BackgroundJobManager();
    const jobs = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 1 });
    const bash = createBashTool({ root, backgroundJobs: jobs });
    const result = await bash.execute(
      {
        command: "printf start; sleep 0.1; printf end",
        background: true,
      },
      createToolContext(),
    );
    expectToolResult(result);
    const jobId = result.result.jobId;

    expect(result.result).toMatchObject({
      background: true,
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      status: "running",
    });
    expect(jobId).toStartWith("job_");
    const output = await readJobToCompletion(jobs, jobId ?? "");
    expect(output).toBe("startend");
    expect(jobs.list()[0]).toMatchObject({ status: "completed", exitCode: 0 });
    await manager.close();
  });

  test("rejects background execution without a session Job client", async () => {
    const root = await createTempRoot();
    const bash = createBashTool({ root });

    await expect(
      bash.execute({ command: "sleep 1", background: true }, createToolContext()),
    ).rejects.toThrow("Background Bash is unavailable without an active session.");
  });

  test("keeps raw shell backgrounding inside the foreground process lifetime", async () => {
    const root = await createTempRoot();
    const sideEffectPath = path.join(root, "escaped.txt");
    const sideEffectDelaySeconds = 1;
    const bash = createBashTool({ root });
    const result = await bash.execute(
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
    const bash = createBashTool({ root });
    const controller = new AbortController();
    const execution = bash.execute(
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
    const bash = createBashTool({ root });
    const result = await bash.execute(
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

async function readJobToCompletion(
  jobs: import("../../src/jobs").BackgroundJobClient,
  jobId: string,
): Promise<string> {
  let output = "";
  for (;;) {
    const snapshot = await jobs.read(jobId, { waitMs: 1_000 });
    output += snapshot.chunks.map((chunk) => chunk.text).join("");
    if (snapshot.status !== "running" && snapshot.status !== "stopping") {
      return output;
    }
  }
}
