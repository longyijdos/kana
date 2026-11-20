import path from "node:path";
import { Type } from "typebox";
import { NON_INTERACTIVE_COMMAND_PREFIX, resolveShell, runCommandProcess } from "./command-process";
import { strictObject } from "./strict-object";
import type { Tool } from "./tool";
import { resolveWorkspaceDirectory } from "./workspace-path";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_SHELL_MAX_TIMEOUT_MS = 5 * 60 * 1000;
export const SHELL_MAX_TIMEOUT_LIMIT_MS = 60 * 60 * 1000;
const MAX_PARTIAL_OUTPUT_CHARS = 20_000;
const PARTIAL_UPDATE_INTERVAL_MS = 100;

type ShellOutputSnapshot = {
  stdout: string;
  stderr: string;
};

function createShellParameters(maxTimeoutMs: number) {
  return strictObject({
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
        maximum: maxTimeoutMs,
        description: `Command timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}; maximum ${maxTimeoutMs}.`,
      }),
    ),
  });
}

export type ShellToolResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type ShellToolOptions = {
  root?: string;
  shell?: string;
  maxTimeoutMs?: number;
};

export function createShellTool(
  options: ShellToolOptions = {},
): Tool<ReturnType<typeof createShellParameters>, ShellToolResult> {
  const root = path.resolve(options.root ?? process.cwd());
  const shell = resolveShell(options.shell);
  const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_SHELL_MAX_TIMEOUT_MS;

  return {
    name: "shell",
    description:
      "Run a foreground command with the current shell. Waits for the complete process group and returns stdout, stderr, and exit status.",
    parameters: createShellParameters(maxTimeoutMs),
    outputSchema: Type.Object({
      exitCode: Type.Union([Type.Number(), Type.Null()]),
      stdout: Type.String(),
      stderr: Type.String(),
      timedOut: Type.Boolean(),
    }),
    // Give shell time to clean up the process group and report its own timeout.
    execution: { deadlineMs: maxTimeoutMs + 1_000 },
    execute: async (args, context) => {
      if (context.signal?.aborted) {
        throw new Error("Command aborted.");
      }

      const command = args.command.trim();

      if (!command) {
        throw new Error("Command is required.");
      }

      const cwd = await resolveWorkspaceDirectory(root, args.cwd ?? ".");
      if (context.signal?.aborted) {
        throw new Error("Command aborted.");
      }

      const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const partialEmitter = createShellPartialEmitter((output) => {
        context.update(createShellPartialResult(output));
      });
      const output: ShellOutputSnapshot = { stdout: "", stderr: "" };
      let result: Awaited<ReturnType<typeof runCommandProcess>>;

      try {
        result = await runCommandProcess({
          command,
          cwd: cwd.absolutePath,
          shell,
          prefix: NON_INTERACTIVE_COMMAND_PREFIX,
          timeoutMs,
          signal: context.signal,
          onOutput: (stream, text) => {
            output[stream] += text;
            partialEmitter.update(output);
          },
        });
      } finally {
        partialEmitter.flush();
      }

      if (result.aborted) {
        throw new Error("Command aborted.");
      }

      // Final output must reach the shared result policy intact so it can be
      // stored as an artifact before model and session views are bounded.
      const toolResult: ShellToolResult = {
        exitCode: result.exitCode,
        stdout: output.stdout,
        stderr: result.timedOut
          ? output.stderr || `Command timed out after ${timeoutMs}ms.`
          : output.stderr,
        timedOut: result.timedOut,
      };

      return {
        content: formatShellContent(toolResult),
        result: toolResult,
        isError: result.timedOut || result.status === "unknown",
      };
    },
  };
}

// Live updates are transient bounded trailing snapshots for presentation, not a
// complete record of the stream. Keep the freshest output so long-running
// commands show recent lines instead of the beginning of the stream.
function tailPartialOutput(content: string): string {
  if (content.length <= MAX_PARTIAL_OUTPUT_CHARS) {
    return content;
  }

  return content.slice(-MAX_PARTIAL_OUTPUT_CHARS);
}

function createShellPartialResult(output: ShellOutputSnapshot): ShellOutputSnapshot {
  return {
    stdout: tailPartialOutput(output.stdout),
    stderr: tailPartialOutput(output.stderr),
  };
}

function createShellPartialEmitter(onOutput: (output: ShellOutputSnapshot) => void): {
  update(output: ShellOutputSnapshot): void;
  flush(): void;
} {
  let latest: ShellOutputSnapshot | undefined;
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

function formatShellContent(result: ShellToolResult): string {
  return [
    `exitCode: ${result.exitCode}`,
    `timedOut: ${result.timedOut}`,
    "",
    "stdout:",
    result.stdout,
    "",
    "stderr:",
    result.stderr,
  ].join("\n");
}
