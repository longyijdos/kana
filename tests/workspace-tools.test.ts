import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createReadTool } from "../src/tools/read";
import type { ToolResult } from "../src/tools/tool";

const tempRoots: string[] = [];

describe("workspace tools", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  test("read returns a line range from a workspace file", async () => {
    const root = await createTempRoot();
    await writeFile(
      path.join(root, "notes.txt"),
      ["one", "two", "three", "four"].join("\n"),
    );
    const read = createReadTool({ root });
    const result = await read.execute(
      {
        path: "notes.txt",
        offset: 2,
        limit: 2,
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toEqual({
      path: "notes.txt",
      content: "two\nthree",
      startLine: 2,
      endLine: 3,
      totalLines: 4,
      truncated: true,
    });
    expect(result.content).toContain("lines: 2-3 of 4");
  });

  test("read accepts absolute paths inside the workspace", async () => {
    const root = await createTempRoot();
    const filePath = path.join(root, "src", "main.ts");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "console.log('hi')\n");
    const read = createReadTool({ root });
    const result = await read.execute(
      {
        path: filePath,
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      path: path.join("src", "main.ts"),
      content: "console.log('hi')",
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      truncated: false,
    });
  });

  test("read rejects paths outside the workspace", async () => {
    const root = await createTempRoot();
    const outside = await createTempRoot();
    const outsideFile = path.join(outside, "secret.txt");
    await writeFile(outsideFile, "secret");
    const read = createReadTool({ root });

    await expect(
      read.execute(
        {
          path: outsideFile,
        },
        createToolContext(),
      ),
    ).rejects.toThrow("Path is outside the workspace");
  });

  test("read rejects symlinks that resolve outside the workspace", async () => {
    const root = await createTempRoot();
    const outside = await createTempRoot();
    const outsideFile = path.join(outside, "secret.txt");
    await writeFile(outsideFile, "secret");
    await symlink(outsideFile, path.join(root, "secret-link.txt"));
    const read = createReadTool({ root });

    await expect(
      read.execute(
        {
          path: "secret-link.txt",
        },
        createToolContext(),
      ),
    ).rejects.toThrow("Path is outside the workspace");
  });
});

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kana-tools-"));
  tempRoots.push(root);

  return root;
}

function createToolContext() {
  return {
    toolCallId: "call_1",
    update() {},
  };
}

function expectToolResult<T>(value: unknown): asserts value is ToolResult<T> {
  expect(value).toBeObject();
  expect(value).toHaveProperty("content");
  expect(value).toHaveProperty("result");
}
