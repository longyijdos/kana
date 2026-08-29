import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolResult } from "../../src/tools/tool";

export function createWorkspaceToolFixture() {
  const tempRoots: string[] = [];

  async function createTempRoot(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "kana-tools-"));
    tempRoots.push(root);

    return root;
  }

  async function cleanupTempRoots(): Promise<void> {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  }

  return { cleanupTempRoots, createTempRoot };
}

export function createToolContext(updates: unknown[] = []) {
  return {
    toolCallId: "call_1",
    update(partialResult: unknown) {
      updates.push(partialResult);
    },
  };
}

export function expectToolResult<T>(value: unknown): asserts value is ToolResult<T> {
  expect(value).toBeObject();
  expect(value).toHaveProperty("content");
  expect(value).toHaveProperty("result");
}
