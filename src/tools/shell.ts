import path from "node:path";
import { Type } from "typebox";
import { NON_INTERACTIVE_COMMAND_PREFIX, resolveShell, runCommandProcess } from "./command-process";
import { strictObject } from "./strict-object";
import type { Tool } from "./tool";
import { resolveWorkspaceDirectory } from "./workspace-path";

export const DEFAULT_TIMEOUT_MS = 30_000;
// Builds and benchmark workloads can legitimately run for minutes, while a ceiling
// keeps one model-issued command from occupying the foreground indefinitely.
const MAX_TIMEOUT_MS = 5 * 60 * 1000;
// Shell owns a deadline just above its ceiling so it can terminate the process group
// and report its own timeout result instead of being canceled by ToolRuntime.
const TOOL_DEADLINE_MS = MAX_TIMEOUT_MS + 1_000;
const MAX_PARTIAL_OUTPUT_CHARS = 20_000;
const PARTIAL_UPDATE_INTERVAL_MS = 100;

type ShellOutputSnapshot = {
  stdout: string;
  stderr: string;
};

export const shellParameters = strictObject({
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
      description: "Command timeout in milliseconds. Defaults to 30000; maximum 300000.",
    }),
  ),
});

export type ShellToolResult = {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type ShellToolOptions = {
  root?: string;
  shell?: string;
};

export function createShellTool(
  options: ShellToolOptions = {},
): Tool<typeof shellParameters, ShellToolResult> {
  const root = path.resolve(options.root ?? process.cwd());
  const shell = resolveShell(options.shell);

  return {
    name: "shell",
    description:
      "Run a foreground command with the current shell. Waits for the complete process group and returns stdout, stderr, and exit status.",
    parameters: shellParameters,
    execution: { deadlineMs: TOOL_DEADLINE_MS },
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
        context.update(createShellPartialResult(command, cwd.relativePath, output));
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
        command,
        cwd: cwd.relativePath,
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

function createShellPartialResult(
  command: string,
  cwd: string,
  output: ShellOutputSnapshot,
): Partial<ShellToolResult> {
  return {
    command,
    cwd,
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
    `command: ${result.command}`,
    `cwd: ${result.cwd}`,
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
