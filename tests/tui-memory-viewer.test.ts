import { describe, expect, test } from "bun:test";
import { KanaTuiApp } from "../src/tui/app/app";
import { stripAnsi } from "../src/tui/render";
import type { Terminal } from "../src/tui/runtime";

describe("memory viewer", () => {
  test("renders Markdown and wraps long memory lines instead of truncating them", () => {
    const longMemory = "This memory entry must remain fully visible after wrapping.";
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
        }) as never,
      createTerminal(),
      {
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
        loadMemory: () => longMemory,
        loadUsage: () => ({
          scope: "session",
          runCount: 0,
          mainRunCount: 0,
          memoryRunCount: 0,
          costCny: 0,
          outcomes: { stop: 0, length: 0, aborted: 0, error: 0, updated: 0, unchanged: 0 },
        }),
      },
    );

    const internal = app as unknown as {
      openMemoryViewer: (target: "user" | "workspace" | undefined) => void;
      layout: { render: (width: number) => string[] };
    };
    internal.openMemoryViewer("user");

    const rendered = internal.layout.render(20);
    const renderedMemory = rendered
      .map(stripAnsi)
      .filter((line) => line.startsWith("  "))
      .map((line) => line.slice(2))
      .join("");

    expect(renderedMemory).toContain(longMemory);
    expect(
      rendered.some((line) => stripAnsi(line).includes("User memory") && line.includes("\x1b[1m")),
    ).toBe(true);
  });
});

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
