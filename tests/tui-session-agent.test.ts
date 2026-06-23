import { describe, expect, test } from "bun:test";
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
});

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
