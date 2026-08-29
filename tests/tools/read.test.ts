import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createReadTool } from "../../src/tools/read";
import {
  createToolContext,
  createWorkspaceToolFixture,
  expectToolResult,
} from "./workspace-fixture";

const { cleanupTempRoots, createTempRoot } = createWorkspaceToolFixture();

describe("read tool", () => {
  afterEach(cleanupTempRoots);

  test("returns a line range from a workspace file", async () => {
    const root = await createTempRoot();
    await writeFile(path.join(root, "notes.txt"), ["one", "two", "three", "four"].join("\n"));
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
});
