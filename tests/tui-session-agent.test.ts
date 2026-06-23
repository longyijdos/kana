import { describe, expect, test } from "bun:test";
import { AgentEventStream } from "../src/agent";
import { createWakeScheduler } from "../src/kana";
import { KanaTuiApp } from "../src/tui/app/app";
import type { Terminal } from "../src/tui/runtime";

describe("session-scoped agents", () => {
  test("recreates the agent after forking so the new session owns later run state", async () => {
    const createdMessages: unknown[][] = [];
    const app = new KanaTuiApp(
      (options) => {
        createdMessages.push(options.messages ?? []);
        return {
          state: {
            messages: [{ role: "user", content: "original" }],
            model: {
              metadata: {
                provider: "test",
                model: "test-model",
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1,
                maxOutputTokens: 1,
              },
            },
          },
        } as never;
      },
      createTerminal(),
      createOptions(),
    );
    const internal = app as unknown as {
      forkSession(prompt: string): Promise<void>;
      submitPrompt(value: string): Promise<void>;
    };
    internal.submitPrompt = async () => {};

    await internal.forkSession("Continue on the fork.");

    expect(createdMessages).toEqual([[], [{ role: "user", content: "original" }]]);
  });

  test("queues due wake events until the active agent run ends", async () => {
    const timers = new Map<number | ReturnType<typeof setTimeout>, () => void>();
    const calls: Array<{ input: unknown; stream: AgentEventStream }> = [];
    const wakeScheduler = createWakeScheduler({
      setTimeout: (callback) => {
        timers.set(1, callback);
        return 1;
      },
      clearTimeout: (timer) => timers.delete(timer),
    });
    const app = new KanaTuiApp(
      () =>
        ({
          state: {
            messages: [],
            model: {
              metadata: {
                provider: "test",
                model: "test-model",
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1,
                maxOutputTokens: 1,
              },
            },
          },
          stream(input: unknown) {
            const stream = new AgentEventStream();
            calls.push({ input, stream });
            return stream;
          },
        }) as never,
      createTerminal(),
      { ...createOptions(), sessionId: "session-a", wakeScheduler },
    );
    const internal = app as unknown as { submitPrompt(value: string): Promise<void> };

    const prompt = internal.submitPrompt("Start the task.");
    expect(calls).toHaveLength(1);
    wakeScheduler.schedule({
      sessionId: "session-a",
      afterMinutes: 30,
      message: "Check the task.",
    });
    timers.get(1)?.();

    expect(calls).toHaveLength(1);
    calls[0]?.stream.end({ type: "agent_end", reason: "stop", messages: [] });
    await prompt;
    await waitFor(() => calls.length === 2);

    expect(calls[1]?.input).toEqual({
      role: "user",
      content: "[Scheduled wake event]\nCheck the task.",
      source: "scheduled",
    });
    calls[1]?.stream.end({ type: "agent_end", reason: "stop", messages: [] });
    wakeScheduler.dispose();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }

  throw new Error("Condition was not met.");
}

function createOptions() {
  return {
    getResumeSessionId: () => undefined,
    createNewSession: () => ({ id: "new" }),
    forkSession: () => ({ id: "fork" }),
    listSessions: () => [],
    loadSession: () => ({ id: "session", messages: [] }),
    deleteSession: () => false,
    loadSkills: () => ({ skills: [], globalEnabledSkillNames: [], diagnostics: [] }),
    saveEnabledGlobalSkills: () => {},
    toolApproval: { config: {}, approvals: {} } as never,
    notification: {} as never,
    compactMemory: async () => [],
    loadMemory: () => "",
    loadUsage: () => ({
      scope: "session" as const,
      runCount: 0,
      mainRunCount: 0,
      memoryRunCount: 0,
      costCny: 0,
      outcomes: { stop: 0, length: 0, aborted: 0, error: 0, updated: 0, unchanged: 0 },
      agents: {
        main: { runCount: 0, costCny: 0 },
        memoryAutomatic: { runCount: 0, costCny: 0 },
        memoryManual: { runCount: 0, costCny: 0 },
      },
      models: [],
    }),
  };
}

function createTerminal(): Terminal {
  return {
    columns: 80,
    rows: 24,
    start: () => {},
    stop: () => {},
    write: () => {},
    notify: () => {},
  };
}
