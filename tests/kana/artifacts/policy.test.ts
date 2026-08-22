import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";

import type { Message } from "@/core";
import type { Logger, LogMetadata } from "@/logging";
import { createBashTool, createGrepTool, createReadTool, type Tool } from "@/tools";
import { ToolRuntime } from "../../../src/agent/tool-runtime";
import {
  createKanaToolResultArtifactPolicy,
  createPersistentKanaSessionArtifactStore,
  type KanaSessionArtifactStore,
} from "../../../src/kana/artifacts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Kana tool-result artifacts", () => {
  test("stores complete oversized text and returns an exactly bounded retrievable preview", async () => {
    const kanaHome = createTempDirectory();
    const cwd = path.join(kanaHome, "workspace");
    mkdirSync(cwd);
    const store = createPersistentKanaSessionArtifactStore({
      sessionId: "session-1",
      cwd,
      env: { KANA_HOME: kanaHome },
    });
    const policy = createKanaToolResultArtifactPolicy({ store });
    const content = `HEAD\n${"内容🙂".repeat(800)}\nTAIL needle`;
    const contentByteLimit = 1_024;

    const result = await policy.finalize({
      toolCall: {
        type: "tool_call",
        id: "call-1",
        name: "bash",
        args: { path: "../../unsafe output.log" },
      },
      content,
      isError: false,
      resultByteLength: Buffer.byteLength(JSON.stringify({ content }), "utf8"),
      contentByteLimit,
    });

    expect(result?.persistResult).toBe(false);
    expect(result?.artifact).toBeDefined();
    const artifact = result?.artifact;
    if (!artifact || !result?.content) {
      throw new Error("Expected an artifact-backed preview.");
    }
    expect(readFileSync(artifact.locator, "utf8")).toBe(content);
    expect(artifact.byteLength).toBe(Buffer.byteLength(content, "utf8"));
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(contentByteLimit);
    expect(result.content).toStartWith("HEAD");
    expect(result.content).toEndWith("TAIL needle");
    expect(result.content).toContain(`Full output locator: ${artifact.locator}`);
    expect(path.basename(artifact.locator)).toMatch(/^[0-9a-f-]+-unsafe-output\.txt$/);

    const omittedBytes = readOmittedByteCount(result.content);
    const notice = formatExpectedNotice(artifact.locator, omittedBytes);
    const retainedBytes =
      Buffer.byteLength(result.content, "utf8") - Buffer.byteLength(notice, "utf8");
    expect(artifact.byteLength - retainedBytes).toBe(omittedBytes);

    const readResult = await createReadTool({ root: cwd }).execute(
      { path: artifact.locator },
      createToolContext(),
    );
    expect(readResult).toMatchObject({ result: { content } });
    const grepResult = await createGrepTool({ root: cwd }).execute(
      { path: artifact.locator, pattern: "needle", literal: true },
      createToolContext(),
    );
    expect(grepResult).toMatchObject({
      result: { matches: [expect.objectContaining({ text: "TAIL needle" })] },
    });

    expect(statSync(path.dirname(path.dirname(path.dirname(artifact.locator)))).mode & 0o777).toBe(
      0o700,
    );
    expect(statSync(path.dirname(path.dirname(artifact.locator))).mode & 0o777).toBe(0o700);
    expect(statSync(path.dirname(artifact.locator)).mode & 0o777).toBe(0o700);
    expect(statSync(artifact.locator).mode & 0o777).toBe(0o600);
  });

  test("stores complete bash output after live updates have been bounded", async () => {
    const kanaHome = createTempDirectory();
    const cwd = path.join(kanaHome, "workspace");
    mkdirSync(cwd);
    const store = createPersistentKanaSessionArtifactStore({
      sessionId: "session-bash",
      cwd,
      env: { KANA_HOME: kanaHome },
    });
    const bash = createBashTool({ root: cwd });
    let liveResult: unknown;
    const runtime = new ToolRuntime(
      {
        tools: [bash],
        toolContentByteLimit: 1_024,
        toolResultPolicy: createKanaToolResultArtifactPolicy({ store }),
      },
      (event) => {
        if (event.type === "tool_execution_end") {
          liveResult = event.result;
        }
      },
    );

    const result = await runtime.execute([
      {
        type: "tool_call",
        id: "call-bash",
        name: "bash",
        args: { command: `awk 'BEGIN { for (i = 0; i < 25000; i++) printf "x" }'` },
      },
    ]);

    expect(liveResult).toMatchObject({
      stdout: "x".repeat(25_000),
    });
    expect(liveResult).not.toHaveProperty("stdoutTruncated");
    expect(liveResult).not.toHaveProperty("stderrTruncated");
    const toolResult = result.toolResults[0];
    expect(toolResult).not.toHaveProperty("result");
    expect(toolResult?.artifact).toBeDefined();
    const locator = toolResult?.artifact?.locator;
    if (!locator) {
      throw new Error("Expected complete bash output to be stored as an artifact.");
    }
    const stored = readFileSync(locator, "utf8");
    expect(stored).toContain("x".repeat(25_000));
    expect(stored).not.toContain("stdoutTruncated");
    expect(stored).not.toContain("stderrTruncated");
    expect(toolResult?.content).toContain(`Full output locator: ${locator}`);
  });

  test("bounds read output without creating a recursive artifact", async () => {
    let saveCount = 0;
    const policy = createKanaToolResultArtifactPolicy({
      store: createRecordingStore(async () => {
        saveCount += 1;
        throw new Error("read must not save");
      }),
    });
    const content = "line\n".repeat(1_000);

    const result = await policy.finalize({
      toolCall: { type: "tool_call", id: "call-1", name: "read", args: {} },
      content,
      isError: false,
      resultByteLength: Buffer.byteLength(JSON.stringify({ content }), "utf8"),
      contentByteLimit: 768,
    });

    expect(saveCount).toBe(0);
    expect(result?.artifact).toBeUndefined();
    expect(result?.persistResult).toBe(false);
    expect(Buffer.byteLength(result?.content ?? "", "utf8")).toBeLessThanOrEqual(768);
    expect(result?.content).toContain("cannot page within one very long line");
  });

  test("keeps structured persistence bounded and logs safe diagnostics when storage fails", async () => {
    const logs: Array<{ event: string; metadata?: LogMetadata }> = [];
    const error = Object.assign(new Error("secret output must not be logged"), {
      code: "ENOSPC",
    });
    const policy = createKanaToolResultArtifactPolicy({
      store: createRecordingStore(async () => {
        throw error;
      }),
      logger: createRecordingLogger(logs),
    });

    const result = await policy.finalize({
      toolCall: { type: "tool_call", id: "call-1", name: "bash", args: {} },
      content: "secret content".repeat(100),
      isError: false,
      resultByteLength: 2_000,
      contentByteLimit: 768,
    });

    expect(result).toEqual({ persistResult: false });
    expect(logs).toEqual([
      {
        event: "tool.result_artifact_save_failed",
        metadata: {
          toolName: "bash",
          phase: "write",
          errorType: "Error",
          errorCode: "ENOSPC",
        },
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain("secret");
  });

  test("keeps failed artifact writes live while omitting non-serializable results from durable messages", async () => {
    const parameters = Type.Object({});
    const canonicalResult = {
      payload: "structured".repeat(300),
      liveOnly: () => "not JSON serializable",
    };
    const tool = {
      name: "large",
      description: "Return oversized text and structured data.",
      parameters,
      execute: () => ({
        content: "artifact text".repeat(300),
        result: canonicalResult,
      }),
    } satisfies Tool<typeof parameters, typeof canonicalResult>;
    const committed: Message[] = [];
    let liveResult: unknown;
    const runtime = new ToolRuntime(
      {
        tools: [tool],
        toolContentByteLimit: 768,
        limitToolContent: () => "ordinary bounded fallback",
        toolResultPolicy: createKanaToolResultArtifactPolicy({
          store: createRecordingStore(async () => {
            throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          }),
        }),
        onMessageCommitted: (message) => {
          committed.push(message);
        },
      },
      (event) => {
        if (event.type === "tool_execution_end") {
          liveResult = event.result;
        }
      },
    );

    const result = await runtime.execute([
      { type: "tool_call", id: "call-large", name: "large", args: {} },
    ]);

    expect(liveResult).toBe(canonicalResult);
    expect(result.toolResults[0]).toMatchObject({ content: "ordinary bounded fallback" });
    expect(result.toolResults[0]).not.toHaveProperty("result");
    expect(committed).toEqual(result.toolResults);
  });

  test("drops an oversized structured result without spilling inline text", async () => {
    let saveCount = 0;
    const policy = createKanaToolResultArtifactPolicy({
      store: createRecordingStore(async () => {
        saveCount += 1;
        throw new Error("inline text must not save");
      }),
    });

    const result = await policy.finalize({
      toolCall: { type: "tool_call", id: "call-1", name: "grep", args: {} },
      content: "short result",
      isError: false,
      resultByteLength: 2_000,
      contentByteLimit: 768,
    });

    expect(saveCount).toBe(0);
    expect(result).toEqual({ persistResult: false });
  });

  test("bounds oversized structured persistence when artifact storage is disabled", async () => {
    const policy = createKanaToolResultArtifactPolicy({});
    const content = "unspilled output".repeat(100);

    const result = await policy.finalize({
      toolCall: { type: "tool_call", id: "call-1", name: "bash", args: {} },
      content,
      isError: false,
      resultByteLength: 2_000,
      contentByteLimit: 768,
    });

    expect(result).toEqual({ persistResult: false });
  });
});

function createTempDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "kana-artifact-policy-"));
  tempDirectories.push(directory);
  return directory;
}

function createRecordingStore(
  saveText: KanaSessionArtifactStore["saveText"],
): KanaSessionArtifactStore {
  return {
    persistent: true,
    saveText,
    async discard() {},
    async close() {},
  };
}

function createRecordingLogger(records: Array<{ event: string; metadata?: LogMetadata }>): Logger {
  const record = (event: string, metadata?: LogMetadata): void => {
    records.push({ event, metadata });
  };
  return { debug: record, info: record, warn: record, error: record };
}

function createToolContext() {
  return {
    toolCallId: "artifact-retrieval",
    update() {},
  };
}

function readOmittedByteCount(content: string): number {
  const match = content.match(/(\d+) UTF-8 bytes omitted/);
  if (!match?.[1]) {
    throw new Error("Artifact preview did not include an omitted byte count.");
  }
  return Number(match[1]);
}

function formatExpectedNotice(locator: string, omittedBytes: number): string {
  return [
    "",
    "",
    `[Tool output stored as a session artifact: ${omittedBytes} UTF-8 bytes omitted from this preview.]`,
    `Full output locator: ${locator}`,
    "Use grep with this locator plus pattern to locate text; for line-oriented output, use read with this locator plus offset/limit.",
    "",
    "",
  ].join("\n");
}
