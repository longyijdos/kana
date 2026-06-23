import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { Tool } from "./tool";
import { resolveWorkspaceDirectory } from "./workspace-path";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 20_000;
const PARTIAL_UPDATE_INTERVAL_MS = 100;
// A background child can inherit stdout/stderr after its shell exits. Give a
// normally exiting shell a brief chance to drain its final output, then stop
// reading so that child cannot keep the tool call open indefinitely.
const OUTPUT_DRAIN_TIMEOUT_MS = 50;
// Keep sudo from prompting on the TUI's raw terminal. It exits immediately
// when credentials are required instead of competing with the editor for input.
const NON_INTERACTIVE_COMMAND_PREFIX = 'sudo() { command sudo -n "$@"; }\n';

type BashOutputSnapshot = {
  stdout: string;
  stderr: string;
};

export const bashParameters = Type.Object({
  command: Type.String({
    description: "Command to execute.",
  }),
  cwd: Type.Optional(
    Type.String({
      default: ".",
      description: "Working directory, relative to the workspace root or absolute.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_TIMEOUT_MS,
      default: DEFAULT_TIMEOUT_MS,
      description: "Command timeout in milliseconds.",
    }),
  ),
});

export type BashToolResult = {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export type BashToolOptions = {
  root?: string;
  shell?: string;
};

export function createBashTool(
  options: BashToolOptions = {},
): Tool<typeof bashParameters, BashToolResult> {
  const root = path.resolve(options.root ?? process.cwd());
  const shell = resolveShell(options.shell);

  return {
    name: "bash",
    description:
      "Run a shell command. Commands execute with the user's shell, requested working directory, timeout, and output truncation.",
    parameters: bashParameters,
    execute: async (args, context) => {
      if (context.signal?.aborted) {
        throw new Error("Command aborted.");
      }

      const command = args.command.trim();

      if (!command) {
        throw new Error("Command is required.");
      }

      const cwd = await resolveWorkspaceDirectory(root, args.cwd ?? ".");
      const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const partialEmitter = createBashPartialEmitter((output) => {
        context.update(createBashPartialResult(command, cwd.relativePath, output));
      });
      let result: Awaited<ReturnType<typeof runCommand>>;

      try {
        result = await runCommand(
          command,
          cwd.absolutePath,
          timeoutMs,
          shell,
          context.signal,
          (output) => partialEmitter.update(output),
        );
      } finally {
        partialEmitter.flush();
      }

      const stdout = truncateOutput(result.stdout);
      const stderr = truncateOutput(result.stderr);
      const toolResult: BashToolResult = {
        command,
        cwd: cwd.relativePath,
        exitCode: result.exitCode,
        stdout: stdout.content,
        stderr: stderr.content,
        timedOut: result.timedOut,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      };

      return {
        content: formatBashContent(toolResult),
        result: toolResult,
        isError: result.exitCode !== 0 || result.timedOut,
      };
    },
  };
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  shell: string,
  signal?: AbortSignal,
  onOutput?: (output: BashOutputSnapshot) => void,
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const output: BashOutputSnapshot = {
    stdout: "",
    stderr: "",
  };
  const outputController = new AbortController();
  let removeAbortListeners: (() => void) | undefined;

  try {
    const proc = Bun.spawn([shell, "-lc", `${NON_INTERACTIVE_COMMAND_PREFIX}${command}`], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // On POSIX, this makes the shell the leader of a separate process group
      // so cancellation can also terminate background children it started.
      detached: true,
    });
    const terminate = () => terminateCommandProcessTree(proc);
    const abortSignals = [timeoutSignal, signal].filter(
      (candidate): candidate is AbortSignal => candidate !== undefined,
    );

    for (const abortSignal of abortSignals) {
      abortSignal.addEventListener("abort", terminate, { once: true });

      if (abortSignal.aborted) {
        terminate();
      }
    }
    removeAbortListeners = () => {
      for (const abortSignal of abortSignals) {
        abortSignal.removeEventListener("abort", terminate);
      }
    };

    const stdoutPromise = readOutputStream(
      proc.stdout,
      "stdout",
      output,
      onOutput,
      outputController.signal,
    );
    const stderrPromise = readOutputStream(
      proc.stderr,
      "stderr",
      output,
      onOutput,
      outputController.signal,
    );
    const outputPromise = Promise.all([stdoutPromise, stderrPromise]);
    const exitCode = await proc.exited;

    await Promise.race([outputPromise, delay(OUTPUT_DRAIN_TIMEOUT_MS)]);
    outputController.abort();
    const [stdout, stderr] = await outputPromise;

    removeAbortListeners();
    removeAbortListeners = undefined;

    const timedOut = timeoutSignal.aborted;

    if (!timedOut && signal?.aborted) {
      throw new Error("Command aborted.");
    }

    return {
      exitCode: timedOut ? null : exitCode,
      stdout,
      stderr: timedOut ? stderr || `Command timed out after ${timeoutMs}ms.` : stderr,
      timedOut,
    };
  } catch (error) {
    removeAbortListeners?.();

    if (timeoutSignal.aborted) {
      return {
        exitCode: null,
        stdout: output.stdout,
        stderr: output.stderr || `Command timed out after ${timeoutMs}ms.`,
        timedOut: true,
      };
    }

    if (signal?.aborted) {
      throw new Error("Command aborted.");
    }

    throw error;
  }
}

async function readOutputStream(
  stream: ReadableStream<Uint8Array>,
  name: keyof BashOutputSnapshot,
  output: BashOutputSnapshot,
  onOutput: ((output: BashOutputSnapshot) => void) | undefined,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };

  signal.addEventListener("abort", cancelReader, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      const chunk = decoder.decode(value, { stream: true });

      if (!chunk) {
        continue;
      }

      output[name] += chunk;
      onOutput?.({
        stdout: output.stdout,
        stderr: output.stderr,
      });
    }

    const remaining = decoder.decode();

    if (remaining) {
      output[name] += remaining;
      onOutput?.({
        stdout: output.stdout,
        stderr: output.stderr,
      });
    }

    return output[name];
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}

function terminateCommandProcessTree(proc: ReturnType<typeof Bun.spawn>): void {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    // The shell may have exited between cancellation and this call. Killing
    // the direct child is still useful when it remains alive.
    proc.kill("SIGKILL");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resolveShell(shell: string | undefined): string {
  const value = shell ?? process.env.SHELL;

  return value?.trim() ? value : "bash";
}

function truncateOutput(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_OUTPUT_CHARS) {
    return {
      content,
      truncated: false,
    };
  }

  return {
    content: content.slice(0, MAX_OUTPUT_CHARS),
    truncated: true,
  };
}

function createBashPartialResult(
  command: string,
  cwd: string,
  output: BashOutputSnapshot,
): Partial<BashToolResult> {
  const stdout = truncateOutput(output.stdout);
  const stderr = truncateOutput(output.stderr);

  return {
    command,
    cwd,
    stdout: stdout.content,
    stderr: stderr.content,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
}

function createBashPartialEmitter(onOutput: (output: BashOutputSnapshot) => void): {
  update(output: BashOutputSnapshot): void;
  flush(): void;
} {
  let latest: BashOutputSnapshot | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastEmittedAt = 0;

  const emit = (): void => {
    if (!latest) {
      return;
    }

    const output = latest;

    latest = undefined;
    lastEmittedAt = Date.now();
    onOutput(output);
  };

  return {
    update(output) {
      latest = {
        stdout: output.stdout,
        stderr: output.stderr,
      };

      const elapsed = Date.now() - lastEmittedAt;

      if (elapsed >= PARTIAL_UPDATE_INTERVAL_MS) {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        emit();
        return;
      }

      if (!timer) {
        timer = setTimeout(() => {
          timer = undefined;
          emit();
        }, PARTIAL_UPDATE_INTERVAL_MS - elapsed);
      }
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }

      emit();
    },
  };
}

function formatBashContent(result: BashToolResult): string {
  return [
    `command: ${result.command}`,
    `cwd: ${result.cwd}`,
    `exitCode: ${result.exitCode}`,
    `timedOut: ${result.timedOut}`,
    `stdoutTruncated: ${result.stdoutTruncated}`,
    `stderrTruncated: ${result.stderrTruncated}`,
    "",
    "stdout:",
    result.stdout,
    "",
    "stderr:",
    result.stderr,
  ].join("\n");
}
