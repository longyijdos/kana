import path from "node:path";
import { Type } from "typebox";

import type {
  BackgroundJobClient,
  BackgroundJobOutputChunk,
  BackgroundJobOutputSnapshot,
  BackgroundJobStatus,
  BackgroundJobSummary,
} from "@/jobs";
import { NON_INTERACTIVE_COMMAND_PREFIX, resolveShell, runCommandProcess } from "./command-process";
import { strictObject } from "./strict-object";
import type { Tool } from "./tool";
import { resolveWorkspaceDirectory } from "./workspace-path";

const MAX_WAIT_MS = 30_000;
const MAX_KILL_REASON_CHARS = 500;

const jobStartParameters = strictObject({
  command: Type.String({ description: "Command to execute in the background." }),
  cwd: Type.Optional(
    Type.String({
      default: ".",
      description:
        "Working directory, relative to the workspace root or absolute. A leading `~` or `~/` expands to the home directory.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 10 * 60 * 1000,
      description: "Command timeout in milliseconds. No timeout by default.",
    }),
  ),
});
const jobListParameters = strictObject({});
const jobOutputParameters = strictObject({
  jobId: Type.String({ minLength: 1, description: "Stable Background Job ID." }),
  waitMs: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: MAX_WAIT_MS,
      default: 0,
      description:
        "Wait up to this many milliseconds for new output or a terminal state. A timeout does not stop the Job.",
    }),
  ),
});
const jobKillParameters = strictObject({
  jobId: Type.String({ minLength: 1, description: "Stable Background Job ID." }),
  reason: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: MAX_KILL_REASON_CHARS,
      description: "Optional reason for stopping the Job.",
    }),
  ),
});

type JobStartResult = {
  command: string;
  cwd: string;
  jobId: string;
  status: BackgroundJobStatus;
};

export function createJobStartTool(
  jobs: BackgroundJobClient,
  options: { root?: string; shell?: string } = {},
): Tool<typeof jobStartParameters, JobStartResult> {
  const root = path.resolve(options.root ?? process.cwd());
  const shell = resolveShell(options.shell);
  return {
    name: "job_start",
    description:
      "Start a session-owned background shell command and return immediately with its Job ID and launch status. The command continues running after this call returns. Completion is delivered back to the parent Agent automatically. Do not poll job_output solely to detect completion.",
    parameters: jobStartParameters,
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
      const result: JobStartResult = {
        command,
        cwd: cwd.relativePath,
        jobId: job.id,
        status: job.status,
      };
      return { content: JSON.stringify(result, null, 2), result };
    },
  };
}

export function createJobListTool(
  jobs: BackgroundJobClient,
): Tool<typeof jobListParameters, BackgroundJobSummary[]> {
  return {
    name: "job_list",
    description:
      "List Background Jobs owned by the current session, including active and recently completed Jobs.",
    parameters: jobListParameters,
    execution: { concurrency: "parallel" },
    execute: () => {
      const result = jobs.list();
      for (const job of result) {
        if (job.status !== "running" && job.status !== "stopping") {
          jobs.observe(job.id);
        }
      }
      return { content: JSON.stringify({ jobs: result }, null, 2), result };
    },
  };
}

export function createJobOutputTool(
  jobs: BackgroundJobClient,
): Tool<typeof jobOutputParameters, BackgroundJobOutputSnapshot> {
  return {
    name: "job_output",
    description:
      "Read all currently unseen retained output from a Background Job. Repeated calls continue from the session's Agent cursor. Completed Jobs notify the parent Agent automatically, so do not repeatedly poll a running Job solely to detect completion. Use waitMs only when explicitly blocking for new output or a result is useful.",
    parameters: jobOutputParameters,
    execution: { concurrency: "parallel", deadlineMs: MAX_WAIT_MS + 1_000 },
    execute: async (args, context) => {
      const result = await jobs.read(args.jobId, {
        waitMs: args.waitMs,
        signal: context.signal,
      });
      return {
        content: formatJobOutput(result),
        result,
        isError: result.status === "unknown",
      };
    },
  };
}

export function createJobKillTool(
  jobs: BackgroundJobClient,
): Tool<typeof jobKillParameters, BackgroundJobSummary> {
  return {
    name: "job_kill",
    description:
      "Stop a Background Job owned by the current session and wait for its process group to become quiescent.",
    parameters: jobKillParameters,
    execute: async (args) => {
      const result = await jobs.kill(args.jobId, {
        source: "tool",
        reason: args.reason,
      });
      return {
        content: JSON.stringify(result, null, 2),
        result,
        isError: result.status === "unknown",
      };
    },
  };
}

function formatJobOutput(snapshot: BackgroundJobOutputSnapshot): string {
  const output = formatOutputChunks(snapshot.chunks);
  return [
    `jobId: ${snapshot.jobId}`,
    `status: ${snapshot.status}`,
    `exitCode: ${snapshot.exitCode}`,
    `droppedBytes: ${snapshot.droppedBytes}`,
    `waitTimedOut: ${snapshot.waitTimedOut}`,
    "",
    output || "(no new output)",
  ].join("\n");
}

function formatOutputChunks(chunks: readonly BackgroundJobOutputChunk[]): string {
  let output = "";
  let currentStream: BackgroundJobOutputChunk["stream"] | undefined;
  for (const chunk of chunks) {
    if (chunk.stream !== currentStream) {
      currentStream = chunk.stream;
      if (output && !output.endsWith("\n")) {
        output += "\n";
      }
      output += `${currentStream}:\n`;
    }
    output += chunk.text;
  }
  return output;
}
