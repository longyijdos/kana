import path from "node:path";
import { Type } from "typebox";
import type { BackgroundJobClient, BackgroundJobStatus } from "@/jobs";
import { NON_INTERACTIVE_COMMAND_PREFIX, resolveShell, runCommandProcess } from "./command-process";
import { strictObject } from "./strict-object";
import type { Tool } from "./tool";
import { resolveWorkspaceDirectory } from "./workspace-path";

const jobStartParameters = strictObject({
  command: Type.String({ description: "Command to execute in the background." }),
  cwd: Type.Optional(
    Type.String({
      default: ".",
      description: "Working directory, relative to the workspace root or absolute.",
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
