import { Type } from "typebox";

import type {
  BackgroundJobClient,
  BackgroundJobOutputChunk,
  BackgroundJobOutputSnapshot,
  BackgroundJobSummary,
} from "@/jobs";
import { strictObject } from "./strict-object";
import type { Tool } from "./tool";

const MAX_WAIT_MS = 30_000;
const MAX_KILL_REASON_CHARS = 500;

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
      "Read all currently unseen retained output from a Background Job. Repeated calls continue from the session's Agent cursor.",
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
    `hasMore: ${snapshot.hasMore}`,
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
