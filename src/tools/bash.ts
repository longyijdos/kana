import { realpath } from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { Tool } from "./tool";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 20_000;

const SAFE_COMMANDS = new Set([
  "pwd",
  "ls",
  "find",
  "rg",
  "cat",
  "sed",
  "head",
  "tail",
  "wc",
]);

const SAFE_BUN_COMMANDS = new Set([
  "test",
  "run typecheck",
  "run build:cli",
]);

const SAFE_GIT_COMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
]);

export const bashParameters = Type.Object({
  command: Type.String({
    description: "Safe command to execute inside the workspace.",
  }),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory, relative to the workspace root or absolute within it.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_TIMEOUT_MS,
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
};

export function createBashTool(options: BashToolOptions = {}): Tool<
  typeof bashParameters,
  BashToolResult
> {
  const root = path.resolve(options.root ?? process.cwd());

  return {
    name: "bash",
    description:
      "Run an allowlisted, non-destructive command inside the workspace. Destructive, network, install, shell-control, and git history-changing commands are rejected.",
    parameters: bashParameters,
    execute: async (args, context) => {
      if (context.signal?.aborted) {
        throw new Error("Command aborted.");
      }

      const command = args.command.trim();

      validateSafeCommand(command);

      const rootPath = await realpath(root);
      const cwd = await resolveWorkspaceDirectory(rootPath, args.cwd ?? ".");
      const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const result = await runCommand(command, cwd.absolutePath, timeoutMs, context.signal);
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

function validateSafeCommand(command: string): void {
  if (!command) {
    throw new Error("Command is required.");
  }

  if (containsShellControl(command)) {
    throw new Error("Shell control operators are not allowed in bash commands.");
  }

  const parts = command.split(/\s+/);
  const executable = parts[0];

  if (!executable || executable.includes("/") || executable.startsWith(".")) {
    throw new Error(`Command is not allowlisted: ${executable ?? command}`);
  }

  if (executable === "git") {
    validateSubcommand("git", parts.slice(1), SAFE_GIT_COMMANDS);
    return;
  }

  if (executable === "bun") {
    validateSubcommand("bun", parts.slice(1), SAFE_BUN_COMMANDS);
    return;
  }

  if (!SAFE_COMMANDS.has(executable)) {
    throw new Error(`Command is not allowlisted: ${executable}`);
  }
}

function validateSubcommand(
  executable: string,
  args: string[],
  allowedSubcommands: ReadonlySet<string>,
): void {
  const subcommand = args.filter((arg) => !arg.startsWith("-")).slice(0, 2).join(" ");

  if (!subcommand || !allowedSubcommands.has(subcommand)) {
    throw new Error(`Command is not allowlisted: ${executable} ${subcommand}`);
  }
}

function containsShellControl(command: string): boolean {
  return /[;&|`$<>()[\]{}*?~!\\\n\r]/.test(command);
}

async function resolveWorkspaceDirectory(
  rootPath: string,
  inputPath: string,
): Promise<{ absolutePath: string; relativePath: string }> {
  if (!inputPath || inputPath.includes("\0")) {
    throw new Error("Invalid working directory.");
  }

  const requestedPath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(rootPath, inputPath);
  const absolutePath = await realpath(requestedPath);

  if (!isInsideDirectory(rootPath, absolutePath)) {
    throw new Error(`Working directory is outside the workspace: ${inputPath}`);
  }

  return {
    absolutePath,
    relativePath: path.relative(rootPath, absolutePath) || ".",
  };
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signals = signal ? [signal, timeoutSignal] : [timeoutSignal];
  const combinedSignal = AbortSignal.any(signals);

  try {
    const proc = Bun.spawn(["bash", "-lc", command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      signal: combinedSignal,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const timedOut = timeoutSignal.aborted;

    return {
      exitCode: timedOut ? null : exitCode,
      stdout,
      stderr: timedOut ? stderr || `Command timed out after ${timeoutMs}ms.` : stderr,
      timedOut,
    };
  } catch (error) {
    if (timeoutSignal.aborted) {
      return {
        exitCode: null,
        stdout: "",
        stderr: `Command timed out after ${timeoutMs}ms.`,
        timedOut: true,
      };
    }

    throw error;
  }
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

function isInsideDirectory(parent: string, child: string): boolean {
  const relativePath = path.relative(parent, child);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
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
