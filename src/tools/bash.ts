import path from "node:path";
import { Type } from "typebox";
import type { BackgroundJobClient, BackgroundJobStatus } from "@/jobs";
import { runCommandProcess } from "./command-process";
import { strictObject } from "./strict-object";
import type { Tool } from "./tool";
import { resolveWorkspaceDirectory } from "./workspace-path";

export const DEFAULT_TIMEOUT_MS = 30_000;
// Builds and benchmark workloads can legitimately run for several minutes, while
// retaining a ceiling prevents a single model-issued command from running forever.
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PARTIAL_OUTPUT_CHARS = 20_000;
const PARTIAL_UPDATE_INTERVAL_MS = 100;
// Keep sudo from prompting on the TUI's raw terminal. It exits immediately
// when credentials are required instead of competing with the editor for input.
const NON_INTERACTIVE_COMMAND_PREFIX = 'sudo() { command sudo -n "$@"; }\n';

type BashOutputSnapshot = {
  stdout: string;
  stderr: string;
};

export const bashParameters = strictObject({
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
      description:
        "Command timeout in milliseconds. Foreground commands default to 30000; background commands have no default timeout.",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "Run as a session-owned background Job and return immediately with a stable Job ID.",
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
  background?: boolean;
  jobId?: string;
  status?: BackgroundJobStatus;
};

export type BashToolOptions = {
  root?: string;
  shell?: string;
  backgroundJobs?: BackgroundJobClient;
};

export function createBashTool(
  options: BashToolOptions = {},
): Tool<typeof bashParameters, BashToolResult> {
  const root = path.resolve(options.root ?? process.cwd());
  const shell = resolveShell(options.shell);

  return {
    name: "bash",
    description:
      "Run a shell command when no purpose-built tool directly covers the operation. Foreground commands wait for their complete process group. Use background=true, not raw shell backgrounding, when work must outlive this call.",
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
      if (context.signal?.aborted) {
        throw new Error("Command aborted.");
      }
      if (args.background) {
        const jobs = options.backgroundJobs;
        if (!jobs) {
          throw new Error("Background Bash is unavailable without an active session.");
        }
        const job = jobs.start({
          kind: "bash",
          label: command,
          cwd: cwd.relativePath,
          run: async ({ signal, write }) => {
            const result = await runCommandProcess({
              command,
              cwd: cwd.absolutePath,
              shell,
              prefix: NON_INTERACTIVE_COMMAND_PREFIX,
              timeoutMs: args.timeoutMs,
              signal,
              onOutput: write,
            });
            return { status: result.status, exitCode: result.exitCode };
          },
        });
        const toolResult: BashToolResult = {
          command,
          cwd: cwd.relativePath,
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          background: true,
          jobId: job.id,
          status: job.status,
        };
        return {
          content: formatBashContent(toolResult),
          result: toolResult,
        };
      }

      const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const partialEmitter = createBashPartialEmitter((output) => {
        context.update(createBashPartialResult(command, cwd.relativePath, output));
      });
      const output: BashOutputSnapshot = { stdout: "", stderr: "" };
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
      const toolResult: BashToolResult = {
        command,
        cwd: cwd.relativePath,
        exitCode: result.exitCode,
        stdout: output.stdout,
        stderr: result.timedOut
          ? output.stderr || `Command timed out after ${timeoutMs}ms.`
          : output.stderr,
        timedOut: result.timedOut,
        background: false,
      };

      return {
        content: formatBashContent(toolResult),
        result: toolResult,
        isError: result.timedOut || result.status === "unknown",
      };
    },
  };
}

function resolveShell(shell: string | undefined): string {
  const value = shell ?? process.env.SHELL;

  return value?.trim() ? value : "bash";
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

function createBashPartialResult(
  command: string,
  cwd: string,
  output: BashOutputSnapshot,
): Partial<BashToolResult> {
  return {
    command,
    cwd,
    stdout: tailPartialOutput(output.stdout),
    stderr: tailPartialOutput(output.stderr),
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
  if (result.background) {
    return [
      `command: ${result.command}`,
      `cwd: ${result.cwd}`,
      "background: true",
      `jobId: ${result.jobId}`,
      `status: ${result.status}`,
    ].join("\n");
  }
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
