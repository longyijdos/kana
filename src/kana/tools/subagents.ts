import { Type } from "typebox";
import type { Tool } from "@/tools";
import type {
  KanaSubagentClient,
  KanaSubagentProfile,
  KanaSubagentRunContext,
  KanaSubagentRunResult,
  KanaSubagentSummary,
} from "../subagents";

const MAX_WAIT_MS = 30_000;
const MAX_TASK_CHARS = 50_000;
const MAX_CANCEL_REASON_CHARS = 500;

const subagentStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("errored"),
  Type.Literal("cancelled"),
  Type.Literal("unknown"),
]);
const terminalReasonSchema = Type.Optional(
  Type.Union([
    Type.Literal("stop"),
    Type.Literal("length"),
    Type.Literal("aborted"),
    Type.Literal("error"),
    Type.Literal("turn_limit"),
  ]),
);

type SpawnSubagentResult = {
  agentId: string;
  status: KanaSubagentSummary["status"];
};

type ContinueSubagentResult = { agentId: string; runNumber: number; status: "running" };

type WaitSubagentResult = {
  runNumber?: number;
  status: KanaSubagentSummary["status"];
  output: string;
  error?: string;
  terminalReason?: KanaSubagentSummary["terminalReason"];
  waitTimedOut: boolean;
};

type CancelSubagentResult = Pick<KanaSubagentSummary, "status" | "terminalReason">;

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
        description: "Wait up to this many milliseconds for the current run to finish.",
      }),
    ),
  },
  { additionalProperties: false },
);

const continueParameters = Type.Object(
  {
    agentId: Type.String({ minLength: 1, description: "ID of a retained, non-running subagent." }),
    message: Type.String({
      minLength: 1,
      maxLength: MAX_TASK_CHARS,
      description: "Follow-up instruction for the next run. The child keeps its own history.",
    }),
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
): Tool<typeof spawnParameters, SpawnSubagentResult> {
  const profiles = new Map(options.profiles.map((profile) => [profile.name, profile]));
  return {
    name: "spawn_subagent",
    description: [
      "Start a new configured, session-owned subagent and return immediately with its stable ID.",
      "The child continues independently after this call returns. Completion is delivered back to the parent Agent automatically; do not poll wait_subagent solely to detect completion.",
      "The child receives only its profile instructions and the task argument, so make the task self-contained.",
      "Choose only from these profiles:",
      ...options.profiles.map((profile) => {
        const tools = options.availableTools(profile);
        return `- ${profile.name}: ${profile.description} Available tools: ${tools.length > 0 ? tools.join(", ") : "none"}.`;
      }),
    ].join("\n"),
    parameters: spawnParameters,
    outputSchema: Type.Object({
      agentId: Type.String(),
      status: subagentStatusSchema,
    }),
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
      const result: SpawnSubagentResult = {
        agentId: summary.id,
        status: summary.status,
      };
      return { content: JSON.stringify(result, null, 2), result };
    },
  };
}

export function createWaitSubagentTool(
  subagents: KanaSubagentClient,
): Tool<typeof waitParameters, WaitSubagentResult> {
  return {
    name: "wait_subagent",
    description:
      "Read the current or latest run of a subagent, optionally waiting for a bounded time. Finished runs notify the parent Agent automatically, so normally wait for that notification instead of repeatedly polling. Use timeoutMs only when explicitly blocking for a result is useful. A timeout does not cancel the subagent.",
    parameters: waitParameters,
    outputSchema: Type.Object({
      status: subagentStatusSchema,
      runNumber: Type.Optional(Type.Integer({ minimum: 1 })),
      output: Type.String(),
      error: Type.Optional(Type.String()),
      terminalReason: terminalReasonSchema,
      waitTimedOut: Type.Boolean(),
    }),
    execution: { concurrency: "parallel", deadlineMs: MAX_WAIT_MS + 1_000 },
    execute: async (args, context) => {
      const snapshot = await subagents.wait(args.agentId, {
        waitMs: args.timeoutMs,
        signal: context.signal,
      });
      const result: WaitSubagentResult = {
        status: snapshot.status,
        ...(snapshot.status === "unknown" ? {} : { runNumber: snapshot.runNumber }),
        output: snapshot.output,
        ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
        ...(snapshot.terminalReason === undefined
          ? {}
          : { terminalReason: snapshot.terminalReason }),
        waitTimedOut: snapshot.waitTimedOut,
      };
      return {
        content: formatWaitResult(result),
        result,
        isError: result.status === "unknown",
      };
    },
  };
}

export function createContinueSubagentTool(
  subagents: KanaSubagentClient,
): Tool<typeof continueParameters, ContinueSubagentResult> {
  return {
    name: "continue_subagent",
    description: [
      "Start another run of a retained subagent in this session after its prior run has completed, errored, or been cancelled. The new run uses the same ID and committed history; it does not replay tool calls.",
      "Read the prior result with wait_subagent before continuing. After an interruption, tell the child to check what was already done before repeating work that may have side effects.",
      "This does not send a message to a running subagent or restore one after a restart. It returns immediately, and the new run reports completion separately.",
    ].join(" "),
    parameters: continueParameters,
    outputSchema: Type.Object({
      agentId: Type.String(),
      runNumber: Type.Integer({ minimum: 2 }),
      status: Type.Literal("running"),
    }),
    execution: { concurrency: "parallel" },
    execute: (args, context) => {
      if (context.signal?.aborted) throw new Error("Subagent continuation was cancelled.");
      const message = args.message.trim();
      if (!message) throw new Error("Subagent follow-up message is required.");
      const summary = subagents.continue(args.agentId, message);
      const result: ContinueSubagentResult = {
        agentId: summary.id,
        runNumber: summary.runNumber,
        status: "running",
      };
      return { content: JSON.stringify(result, null, 2), result };
    },
  };
}

export function createCancelSubagentTool(
  subagents: KanaSubagentClient,
): Tool<typeof cancelParameters, CancelSubagentResult> {
  return {
    name: "cancel_subagent",
    description: "Cancel one live subagent and wait for its owned work to settle.",
    parameters: cancelParameters,
    outputSchema: Type.Object({
      status: subagentStatusSchema,
      terminalReason: terminalReasonSchema,
    }),
    execution: { concurrency: "parallel" },
    execute: async (args) => {
      const summary = await subagents.cancel(args.agentId, {
        source: "tool",
        reason: args.reason,
      });
      const result: CancelSubagentResult = {
        status: summary.status,
        ...(summary.terminalReason === undefined ? {} : { terminalReason: summary.terminalReason }),
      };
      return {
        content: JSON.stringify(result, null, 2),
        result,
        isError: result.status === "unknown",
      };
    },
  };
}

function formatWaitResult(result: WaitSubagentResult): string {
  return [
    `status: ${result.status}`,
    ...(result.runNumber === undefined ? [] : [`runNumber: ${result.runNumber}`]),
    `terminalReason: ${result.terminalReason ?? "n/a"}`,
    `waitTimedOut: ${result.waitTimedOut}`,
    ...(result.error ? [`error: ${result.error}`] : []),
    "",
    result.output || "(no final output)",
  ].join("\n");
}
