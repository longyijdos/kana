import type { BeforeToolExecutionHook } from "@/agent";
import { createUserMessage } from "@/core";
import {
  ConversationRuntime,
  type createKanaConversationHost,
  type KanaGoalSnapshot,
  type KanaToolApprovalConfig,
  type KanaToolApprovals,
  shouldRequestToolApproval,
} from "@/kana";
import type { Logger } from "@/logging";
import { HeadlessRunLifecycle } from "./run-lifecycle";
import {
  type HeadlessOutputStream,
  HeadlessRunOutputProjector,
  type HeadlessRunResult,
  type HeadlessWarning,
} from "./run-output";
import { assertValidHeadlessTimeoutMs } from "./timeout";

export type RunHeadlessConversationOptions = {
  runtime: ConversationRuntime;
  prompt: string;
  goal?: boolean;
  approvalConfig: KanaToolApprovalConfig;
  toolApprovals: KanaToolApprovals;
  allowAllTools?: boolean;
  json?: boolean;
  warnings?: readonly HeadlessWarning[];
  signal?: AbortSignal;
  timeoutMs?: number;
  logger?: Logger;
  stdout?: HeadlessOutputStream;
  stderr?: HeadlessOutputStream;
};

export async function runHeadlessConversation(
  options: RunHeadlessConversationOptions,
): Promise<HeadlessRunResult> {
  assertValidHeadlessTimeoutMs(options.timeoutMs);
  const lifecycle = new HeadlessRunLifecycle({
    runtime: options.runtime,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    logger: options.logger,
  });
  const output = new HeadlessRunOutputProjector({
    goal: options.goal ?? false,
    json: options.json ?? false,
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    getTermination: () => lifecycle.termination,
  });
  output.startSession(options.runtime.sessionId);
  for (const warning of options.warnings ?? []) {
    output.warning(warning);
  }

  options.runtime.setBeforeToolExecution(createHeadlessApprovalHook(options, output));
  lifecycle.connect();
  const unsubscribe = options.runtime.subscribe((event) => {
    output.handle(event);
  });
  const goalCompletion = options.goal ? waitForGoalCompletion(options.runtime) : undefined;

  try {
    lifecycle.startDeadline();
    output.startRun();
    const submission = options.goal
      ? options.runtime.startGoal(options.prompt)
      : options.runtime.submit(
          createUserMessage({
            content: options.prompt,
            provenance: { kind: "user_input" },
          }),
        );
    lifecycle.abortIfSignaled();
    await submission;
    output.throwIfWriteFailed();
    if (goalCompletion) {
      output.completeGoal(await goalCompletion.promise);
    }
    output.throwIfWriteFailed();
    return output.result();
  } catch (error) {
    output.throwIfWriteFailed();
    // Runtime failures normally publish run_error before rejecting submission.
    output.fail(error);
    output.throwIfWriteFailed();
    return output.result();
  } finally {
    goalCompletion?.unsubscribe();
    unsubscribe();
    lifecycle.dispose();
  }
}

export function createHeadlessRuntime(
  host: ReturnType<typeof createKanaConversationHost>,
  backgroundJobCompletionRuns: boolean,
): ConversationRuntime {
  return new ConversationRuntime({
    initialSession: host.initialSession
      ? {
          id: host.initialSession.metadata.id,
          messages: host.initialSession.messages,
          timeline: host.initialSession.timeline,
          todoState: host.initialSession.todoState,
          contextCheckpoint: host.initialSession.contextCheckpoint,
        }
      : undefined,
    createAgent: (agentOptions) => host.createAgent(agentOptions),
    createNewSession: () => host.createNewSession(),
    forkSession: (messages, contextCheckpoint, prompt) =>
      host.forkSession(messages, contextCheckpoint, prompt),
    loadSession: (sessionId) => {
      const session = host.loadSession(sessionId);
      return {
        id: session.metadata.id,
        messages: session.messages,
        timeline: session.timeline,
        todoState: session.todoState,
        contextCheckpoint: session.contextCheckpoint,
      };
    },
    wakeScheduler: host.wakeScheduler,
    goalMaxRounds: host.config.agent.goalMaxRounds,
    getBackgroundJobs: (sessionId) => host.getBackgroundJobs(sessionId),
    disposeSession: (sessionId, source, foregroundSettled) =>
      host.disposeSession(sessionId, source, foregroundSettled),
    backgroundJobCompletionRuns,
    scheduledRuns: false,
    getLogger: () => host.getLogger(),
  });
}

function createHeadlessApprovalHook(
  options: RunHeadlessConversationOptions,
  output: HeadlessRunOutputProjector,
): BeforeToolExecutionHook {
  return ({ toolCall }) => {
    if (
      options.allowAllTools ||
      !shouldRequestToolApproval(options.approvalConfig, options.toolApprovals, toolCall)
    ) {
      return { type: "continue" };
    }

    const message = `Tool ${toolCall.name} requires interactive approval. Re-run with --allow-all-tools to authorize it.`;
    output.approvalDenied(message);
    return {
      type: "cancel",
      abortRun: true,
      message,
    };
  };
}

function waitForGoalCompletion(runtime: ConversationRuntime): {
  promise: Promise<KanaGoalSnapshot>;
  unsubscribe(): void;
} {
  let activeGoalId: string | undefined;
  let terminalGoal: KanaGoalSnapshot | undefined;
  let resolveCompletion: (goal: KanaGoalSnapshot) => void = () => {};
  const promise = new Promise<KanaGoalSnapshot>((resolve) => {
    resolveCompletion = resolve;
  });
  let settled = false;
  const settle = (): void => {
    if (settled || terminalGoal === undefined) {
      return;
    }
    settled = true;
    resolveCompletion(terminalGoal);
  };
  const unsubscribe = runtime.subscribe((event) => {
    if (event.type === "goal_state_changed") {
      if (event.change === "started") {
        activeGoalId = event.goal.id;
      }
      if (event.goal.id !== activeGoalId || event.goal.status === "active") {
        return;
      }
      terminalGoal = structuredClone(event.goal);
      if (!runtime.isRunning) {
        settle();
      }
      return;
    }
    if (terminalGoal !== undefined && (event.type === "run_end" || event.type === "run_error")) {
      settle();
    }
  });
  return { promise, unsubscribe };
}
