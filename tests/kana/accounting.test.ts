import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendKanaRunAccounting,
  loadKanaUsageSummary,
  recordKanaAgentRunAccounting,
} from "@/kana";
import { messageIdentityForTest } from "../helpers/messages";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Kana accounting", () => {
  test("aggregates session, project, and global run ledgers", () => {
    const env = { KANA_HOME: temporaryHome() };
    const workspace = "/work/one";
    appendKanaRunAccounting(record("session-one", "main", 10), { env, cwd: workspace });
    appendKanaRunAccounting(record("session-two", "memory_consolidation", 20), {
      env,
      cwd: workspace,
    });
    appendKanaRunAccounting(record("elsewhere", "main", 30), { env, cwd: "/work/two" });

    expect(
      loadKanaUsageSummary({ scope: "session", sessionId: "session-one", env, cwd: workspace }),
    ).toMatchObject({
      runCount: 1,
      mainRunCount: 1,
      memoryRunCount: 0,
      usage: { totalTokens: 10 },
    });
    expect(loadKanaUsageSummary({ scope: "project", env, cwd: workspace })).toMatchObject({
      runCount: 2,
      mainRunCount: 1,
      memoryRunCount: 1,
      usage: { totalTokens: 30 },
    });
    const globalSummary = loadKanaUsageSummary({ scope: "global", env, cwd: workspace });
    expect(globalSummary).toMatchObject({ runCount: 3, usage: { totalTokens: 60 } });
  });

  test("writes token-only version 2 records", () => {
    const env = { KANA_HOME: temporaryHome() };
    const appended = appendKanaRunAccounting(record("session-one", "main", 10), {
      env,
      cwd: "/work/one",
    });

    expect(appended).toMatchObject({ version: 2, usage: { totalTokens: 10 } });
    expect(Object.hasOwn(appended, "pricing")).toBe(false);
    expect(Object.hasOwn(appended, "costCny")).toBe(false);
  });

  test("counts turn-limited runs separately from normal completion", () => {
    const env = { KANA_HOME: temporaryHome() };
    const workspace = "/work/one";
    appendKanaRunAccounting(
      {
        ...record("session-one", "main", 10),
        outcome: "turn_limit",
      },
      { env, cwd: workspace },
    );

    expect(
      loadKanaUsageSummary({ scope: "session", sessionId: "session-one", env, cwd: workspace })
        .outcomes,
    ).toMatchObject({
      stop: 0,
      turn_limit: 1,
    });
  });

  test("includes context-compaction usage in the main run ledger", () => {
    const previousKanaHome = process.env.KANA_HOME;
    const kanaHome = temporaryHome();
    process.env.KANA_HOME = kanaHome;

    try {
      recordKanaAgentRunAccounting({
        sessionId: "session-compact",
        cwd: "/work/compact",
        agentKind: "main",
        outcome: "stop",
        messages: [
          {
            ...messageIdentityForTest("assistant"),
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            usage: {
              promptTokens: 100,
              completionTokens: 20,
              totalTokens: 120,
            },
          },
        ],
        additionalUsage: {
          promptTokens: 50,
          completionTokens: 10,
          totalTokens: 60,
        },
        model: {
          provider: "test",
          model: "test-model",
          contextWindow: 1_000,
          maxOutputTokens: 100,
          supportsParallelToolCalls: false,
          protocol: null,
          supportsHostedWebSearch: false,
        },
      });

      expect(
        loadKanaUsageSummary({
          scope: "session",
          sessionId: "session-compact",
          cwd: "/work/compact",
          env: { KANA_HOME: kanaHome },
        }),
      ).toMatchObject({
        runCount: 1,
        usage: {
          promptTokens: 150,
          completionTokens: 30,
          totalTokens: 180,
        },
      });
    } finally {
      if (previousKanaHome === undefined) {
        delete process.env.KANA_HOME;
      } else {
        process.env.KANA_HOME = previousKanaHome;
      }
    }
  });
});

function record(sessionId: string, agentKind: "main" | "memory_consolidation", tokens: number) {
  return {
    sessionId,
    agentKind,
    outcome: "stop" as const,
    model: { provider: "test", model: "test-model" },
    usage: { promptTokens: tokens, completionTokens: 0, totalTokens: tokens },
    assistantMessageCount: 1,
  };
}

function temporaryHome(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "kana-accounting-"));
  directories.push(directory);
  return directory;
}
