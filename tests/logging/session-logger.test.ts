import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSessionLogger, createSessionLogManager } from "@/logging";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("session logger", () => {
  test("writes level-filtered JSONL records", () => {
    const logPath = path.join(createTempDir(), "logs", "session.jsonl");
    const logger = createSessionLogger({
      path: logPath,
      sessionId: "session-1",
      level: "info",
      now: () => new Date("2026-06-22T12:00:00.000Z"),
    });

    logger.debug("agent.turn_started", { turn: 1 });
    logger.info("agent.run_started", { promptMessageCount: 1 });
    logger.error("agent.failed", { error: new Error("unexpected") });

    const records = readLogRecords(logPath);
    expect(records).toEqual([
      {
        timestamp: "2026-06-22T12:00:00.000Z",
        level: "info",
        event: "agent.run_started",
        sessionId: "session-1",
        metadata: { promptMessageCount: 1 },
      },
      expect.objectContaining({
        level: "error",
        event: "agent.failed",
        sessionId: "session-1",
        metadata: {
          error: expect.objectContaining({ name: "Error", message: "unexpected" }),
        },
      }),
    ]);
  });

  test("redacts sensitive metadata recursively", () => {
    const logPath = path.join(createTempDir(), "session.jsonl");
    const logger = createSessionLogger({ path: logPath, sessionId: "session-1", level: "debug" });

    logger.debug("provider.request", {
      apiKey: "secret",
      request: {
        authorization: "Bearer secret",
        safe: "value",
      },
    });

    expect(readLogRecords(logPath)[0]).toMatchObject({
      metadata: {
        apiKey: "[REDACTED]",
        request: {
          authorization: "[REDACTED]",
          safe: "value",
        },
      },
    });
  });

  test("does not create a file when logging is off", () => {
    const logPath = path.join(createTempDir(), "session.jsonl");
    const logger = createSessionLogger({ path: logPath, sessionId: "session-1", level: "off" });

    logger.error("agent.failed");

    expect(existsSync(logPath)).toBe(false);
  });

  test("appends when a session logger is recreated for a resumed session", () => {
    const logPath = path.join(createTempDir(), "session.jsonl");
    createSessionLogger({ path: logPath, sessionId: "session-1", level: "info" }).info(
      "session.started",
    );
    createSessionLogger({ path: logPath, sessionId: "session-1", level: "info" }).info(
      "session.resumed",
    );

    expect(readLogRecords(logPath).map((record) => (record as { event: string }).event)).toEqual([
      "session.started",
      "session.resumed",
    ]);
  });

  test("binds independent loggers to each requested session", () => {
    const logDirectory = createTempDir();
    const manager = createSessionLogManager({ level: "info" });
    const firstPath = path.join(logDirectory, "first.jsonl");
    const secondPath = path.join(logDirectory, "second.jsonl");

    const firstLogger = manager.forSession({ path: firstPath, sessionId: "first" });
    const secondLogger = manager.forSession({ path: secondPath, sessionId: "second" });
    firstLogger.info("memory_consolidation.ended");
    secondLogger.info("session.resumed");

    expect(readLogRecords(firstPath)).toEqual([
      expect.objectContaining({ event: "memory_consolidation.ended", sessionId: "first" }),
    ]);
    expect(readLogRecords(secondPath)).toEqual([
      expect.objectContaining({ event: "session.resumed", sessionId: "second" }),
    ]);
  });

  test("suppresses filesystem failures", () => {
    const tempDir = createTempDir();
    const blockedParent = path.join(tempDir, "not-a-directory");
    writeFileSync(blockedParent, "blocked");
    const logger = createSessionLogger({
      path: path.join(blockedParent, "session.jsonl"),
      sessionId: "session-1",
      level: "info",
    });

    expect(() => logger.info("agent.started")).not.toThrow();
  });
});

function createTempDir(): string {
  const tempDir = mkdtempSync(path.join(tmpdir(), "kana-session-logger-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function readLogRecords(logPath: string): unknown[] {
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
