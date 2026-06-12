import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import {
  appendKanaSessionMessages,
  createKanaSession,
  getKanaConfigPaths,
  listKanaSessions,
  loadKanaSession,
} from "@/kana";
import type { Message } from "@/core";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Kana session store", () => {
  test("creates JSONL sessions and reloads appended messages by id", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({
      cwd,
      env,
      id: "session-1",
      model: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
      },
    });
    const messages: Message[] = [
      {
        role: "user",
        content: "hi",
      },
      {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "hello",
          },
        ],
      },
    ];

    appendKanaSessionMessages(session, messages, {
      timestamp: "2026-06-12T00:00:00.000Z",
    });

    const loaded = loadKanaSession("session-1", { env, cwd });
    const lines = readFileSync(session.path, "utf8").trim().split("\n");
    const firstEntry = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
    const secondEntry = JSON.parse(lines[2] ?? "{}") as Record<string, unknown>;

    expect(loaded.metadata).toEqual(session);
    expect(loaded.messages).toEqual(messages);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      type: "session",
      version: 1,
      id: "session-1",
      cwd,
      model: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
      },
    });
    expect(firstEntry).toMatchObject({
      type: "message",
      parentId: null,
      timestamp: "2026-06-12T00:00:00.000Z",
      message: {
        role: "user",
      },
    });
    expect(secondEntry).toMatchObject({
      type: "message",
      parentId: firstEntry.id,
      timestamp: "2026-06-12T00:00:00.000Z",
      message: {
        role: "assistant",
      },
    });
  });

  test("lists sessions from the configured Kana home", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const first = createKanaSession({ cwd, env, id: "first" });
    const second = createKanaSession({ cwd, env, id: "second" });

    expect(new Set(listKanaSessions({ env, cwd }).map((session) => session.id))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(new Set(listKanaSessions({ env }).map((session) => session.id))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(getKanaConfigPaths(env).sessionsPath).toContain(".kana/sessions");
  });
});

function createTempEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), "kana-session-"));
  tempDirs.push(home);
  mkdirSync(path.join(home, ".kana"), { recursive: true });

  return {
    HOME: home,
  };
}
