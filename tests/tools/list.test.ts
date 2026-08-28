import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createListTool } from "../../src/tools/list";
import {
  createToolContext,
  createWorkspaceToolFixture,
  expectToolResult,
} from "./workspace-fixture";

const { cleanupTempRoots, createTempRoot } = createWorkspaceToolFixture();

describe("list tool", () => {
  afterEach(cleanupTempRoots);

  test("returns sorted direct directory entries", async () => {
    const root = await createTempRoot();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, ".env"), "SECRET=value\n");
    await writeFile(path.join(root, "notes.txt"), "hello\n");
    const list = createListTool({ root });
    const result = await list.execute(
      {
        path: ".",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      path: ".",
      totalEntries: 3,
      truncated: false,
    });
    expect(result.result.entries).toEqual([
      expect.objectContaining({ name: ".env", path: ".env", type: "file" }),
      expect.objectContaining({ name: "notes.txt", path: "notes.txt", type: "file" }),
      expect.objectContaining({ name: "src", path: "src", type: "directory" }),
    ]);
    expect(result.content).toContain("entries: 3 of 3");
  });

  test("can exclude hidden entries and truncate output", async () => {
    const root = await createTempRoot();
    await writeFile(path.join(root, ".hidden"), "secret\n");
    await writeFile(path.join(root, "a.txt"), "a\n");
    await writeFile(path.join(root, "b.txt"), "b\n");
    const list = createListTool({ root });
    const result = await list.execute(
      {
        path: ".",
        includeHidden: false,
        limit: 1,
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      totalEntries: 2,
      truncated: true,
    });
    expect(result.result.entries).toEqual([
      expect.objectContaining({ name: "a.txt", path: "a.txt", type: "file" }),
    ]);
  });
});
