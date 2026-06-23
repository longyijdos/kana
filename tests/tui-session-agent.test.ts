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
