import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendKanaRunAccounting, loadKanaUsageSummary } from "@/kana";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Kana accounting", () => {
  test("aggregates session, project, and global run ledgers", () => {
    const env = { KANA_HOME: temporaryHome() };
    const workspace = "/work/one";
    appendKanaRunAccounting(record("session-one", "main", 10, 0.01), { env, cwd: workspace });
    appendKanaRunAccounting(record("session-two", "memory_consolidation", 20, 0.02), {
      env,
      cwd: workspace,
    });
    appendKanaRunAccounting(record("elsewhere", "main", 30, 0.03), { env, cwd: "/work/two" });

    expect(
      loadKanaUsageSummary({ scope: "session", sessionId: "session-one", env, cwd: workspace }),
    ).toMatchObject({
      runCount: 1,
      mainRunCount: 1,
      memoryRunCount: 0,
      costCny: 0.01,
      usage: { totalTokens: 10 },
    });
    expect(loadKanaUsageSummary({ scope: "project", env, cwd: workspace })).toMatchObject({
      runCount: 2,
      mainRunCount: 1,
      memoryRunCount: 1,
      costCny: 0.03,
      usage: { totalTokens: 30 },
    });
    const globalSummary = loadKanaUsageSummary({ scope: "global", env, cwd: workspace });
    expect(globalSummary).toMatchObject({ runCount: 3, usage: { totalTokens: 60 } });
    expect(globalSummary.costCny).toBeCloseTo(0.06);
  });
});

function record(
  sessionId: string,
  agentKind: "main" | "memory_consolidation",
  tokens: number,
  costCny: number,
) {
  return {
    sessionId,
    agentKind,
    outcome: "stop" as const,
    model: { provider: "test", model: "test-model" },
    pricing: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 },
    usage: { promptTokens: tokens, completionTokens: 0, totalTokens: tokens },
    costCny,
    assistantMessageCount: 1,
  };
}

function temporaryHome(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "kana-accounting-"));
  directories.push(directory);
  return directory;
}
