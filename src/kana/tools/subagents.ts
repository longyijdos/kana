import { Type } from "typebox";
import type { Tool } from "@/tools";
import type {
  KanaSubagentClient,
  KanaSubagentProfile,
  KanaSubagentRunContext,
  KanaSubagentRunResult,
} from "../subagents";

const MAX_WAIT_MS = 30_000;
const MAX_TASK_CHARS = 50_000;
const MAX_CANCEL_REASON_CHARS = 500;

const spawnParameters = Type.Object(
  {
    profile: Type.String({ minLength: 1, description: "Name of a configured subagent profile." }),
    task: Type.String({
      minLength: 1,
      maxLength: MAX_TASK_CHARS,
      description:
        "One bounded, self-contained task. Include every relevant context item, constraint, path, and expected result because the child does not inherit the parent prompt or runtime context.",
    }),
  },
  { additionalProperties: false },
);

const waitParameters = Type.Object(
  {
    agentId: Type.String({ minLength: 1, description: "Stable subagent ID." }),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: MAX_WAIT_MS,
        default: 0,
        description: "Wait up to this many milliseconds for a terminal state.",
      }),
    ),
  },
  { additionalProperties: false },
);

const cancelParameters = Type.Object(
  {
    agentId: Type.String({ minLength: 1, description: "Stable subagent ID." }),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_CANCEL_REASON_CHARS })),
  },
  { additionalProperties: false },
);

export type CreateKanaSubagentToolsOptions = {
  subagents: KanaSubagentClient;
  profiles: readonly KanaSubagentProfile[];
  availableTools(profile: KanaSubagentProfile): readonly string[];
  run(context: KanaSubagentRunContext): Promise<KanaSubagentRunResult>;
};

export function createSpawnSubagentTool(
  options: CreateKanaSubagentToolsOptions,
): Tool<typeof spawnParameters> {
  const profiles = new Map(options.profiles.map((profile) => [profile.name, profile]));
  return {
    name: "spawn_subagent",
    description: [
      "Start one configured, session-owned one-shot subagent and return immediately with its stable ID.",
      "The child receives only its profile instructions and the task argument, so make the task self-contained.",
      "Choose only from these profiles:",
      ...options.profiles.map((profile) => {
        const tools = options.availableTools(profile);
        return `- ${profile.name}: ${profile.description} Available tools: ${tools.length > 0 ? tools.join(", ") : "none"}.`;
      }),
    ].join("\n"),
    parameters: spawnParameters,
    execution: { concurrency: "parallel" },
    execute: (args, context) => {
      if (context.signal?.aborted) throw new Error("Subagent spawn was cancelled.");
      const profile = profiles.get(args.profile);
      if (!profile) throw new Error(`Unknown subagent profile: ${args.profile}`);
      const task = args.task.trim();
      if (!task) throw new Error("Subagent task is required.");
      const summary = options.subagents.start({
        profile,
        task,
        spawnToolCallId: context.toolCallId,
        run: options.run,
      });
      const result = {
        agentId: summary.id,
        profile: summary.profile,
        status: summary.status,
      };
      return { content: JSON.stringify(result, null, 2), result };
    },
  };
}

export function createWaitSubagentTool(subagents: KanaSubagentClient): Tool<typeof waitParameters> {
  return {
    name: "wait_subagent",
    description:
      "Read a subagent's current or terminal result, optionally waiting for a bounded time. A timeout does not cancel the subagent.",
    parameters: waitParameters,
    execution: { concurrency: "parallel", deadlineMs: MAX_WAIT_MS + 1_000 },
    execute: async (args, context) => {
      const result = await subagents.wait(args.agentId, {
        waitMs: args.timeoutMs,
        signal: context.signal,
      });
      return {
        content: formatWaitResult(result),
        result,
        isError: result.status === "unknown" || result.status === "errored",
      };
    },
  };
}

export function createCancelSubagentTool(
  subagents: KanaSubagentClient,
): Tool<typeof cancelParameters> {
  return {
    name: "cancel_subagent",
    description: "Cancel one live subagent and wait for its owned work to settle.",
    parameters: cancelParameters,
    execution: { concurrency: "parallel" },
    execute: async (args) => {
      const result = await subagents.cancel(args.agentId, {
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

function formatWaitResult(result: Awaited<ReturnType<KanaSubagentClient["wait"]>>): string {
  return [
    `agentId: ${result.id}`,
    `profile: ${result.profile}`,
    `status: ${result.status}`,
    `terminalReason: ${result.terminalReason ?? "n/a"}`,
    `waitTimedOut: ${result.waitTimedOut}`,
    ...(result.error ? [`error: ${result.error}`] : []),
    "",
    result.output || "(no final output)",
  ].join("\n");
}
