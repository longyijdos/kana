import { describe, expect, test } from "bun:test";
import type { ToolResultMessage } from "@/core";
import { DEFAULT_KANA_CONFIG } from "@/kana";
import type { Logger } from "@/logging";
import { createMemoryConsolidationScheduler } from "../src/kana/memory";

describe("memory consolidation scheduler", () => {
  test("does not log or schedule when no successful remember entries exist", async () => {
    const events: string[] = [];
    const logger: Logger = {
      debug: (event) => events.push(event),
      info: (event) => events.push(event),
      warn: (event) => events.push(event),
      error: (event) => events.push(event),
    };
    const scheduler = createMemoryConsolidationScheduler(DEFAULT_KANA_CONFIG, { logger });

    await scheduler.schedule([
      { role: "tool", toolCallId: "call_read", toolName: "read", content: "", isError: false },
    ]);

    expect(events).toEqual([]);
  });

  test("groups successful remember entries by scope", async () => {
    const calls: Array<{ scope: string; entries: string[] }> = [];
    const scheduler = createMemoryConsolidationScheduler(DEFAULT_KANA_CONFIG, {
      runIncremental: async (scope, entries) => {
        calls.push({ scope, entries: entries.map((entry) => entry.id) });
      },
    });

    await scheduler.schedule([
      rememberResult("project", "mem_project_1"),
      rememberResult("project", "mem_project_2"),
      rememberResult("global", "mem_global"),
      { ...rememberResult("project", "mem_failed"), isError: true },
      { role: "tool", toolCallId: "call_read", toolName: "read", content: "", isError: false },
    ]);

    expect(calls).toEqual([
      { scope: "project", entries: ["mem_project_1", "mem_project_2"] },
      { scope: "global", entries: ["mem_global"] },
    ]);
  });

  test("serializes runs for the same scope", async () => {
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const scheduler = createMemoryConsolidationScheduler(DEFAULT_KANA_CONFIG, {
      runIncremental: async (_scope, entries) => {
        started.push(entries[0].id);
        if (entries[0].id === "mem_first") {
          await firstRun;
        }
      },
    });

    const first = scheduler.schedule([rememberResult("project", "mem_first")]);
    const second = scheduler.schedule([rememberResult("project", "mem_second")]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["mem_first"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(started).toEqual(["mem_first", "mem_second"]);
  });
});

function rememberResult(scope: "global" | "project", id: string): ToolResultMessage {
  return {
    role: "tool",
    toolCallId: `call_${id}`,
    toolName: "remember",
    content: `Memory recorded in ${scope} scope.`,
    result: {
      id,
      createdAt: "2026-06-20T00:00:00.000Z",
      scope,
      content: `Content for ${id}`,
    },
    isError: false,
  };
}
