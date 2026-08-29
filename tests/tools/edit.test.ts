import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createEditTool } from "../../src/tools/edit";
import {
  createToolContext,
  createWorkspaceToolFixture,
  expectToolResult,
} from "./workspace-fixture";

const { cleanupTempRoots, createTempRoot } = createWorkspaceToolFixture();

describe("edit tool", () => {
  afterEach(cleanupTempRoots);

  test("replaces a unique text match in an existing file", async () => {
    const root = await createTempRoot();
    await writeFile(path.join(root, "notes.txt"), "hello world\n");
    const edit = createEditTool({ root });
    const result = await edit.execute(
      {
        path: "notes.txt",
        oldText: "world",
        newText: "kana",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      path: "notes.txt",
      replacements: 1,
      bytesWritten: 11,
      oldText: "world",
      newText: "kana",
    });
    expect(result.content).toContain("edited: notes.txt");
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("hello kana\n");
  });

  test("rejects missing old text", async () => {
    const root = await createTempRoot();
    await writeFile(path.join(root, "notes.txt"), "hello world\n");
    const edit = createEditTool({ root });

    await expect(
      edit.execute(
        {
          path: "notes.txt",
          oldText: "missing",
          newText: "kana",
        },
        createToolContext(),
      ),
    ).rejects.toThrow("Text not found");
  });

  test("rejects repeated old text unless replaceAll is true", async () => {
    const root = await createTempRoot();
    await writeFile(path.join(root, "notes.txt"), "x = 1\nx = 2\n");
    const edit = createEditTool({ root });

    await expect(
      edit.execute(
        {
          path: "notes.txt",
          oldText: "x",
          newText: "y",
        },
        createToolContext(),
      ),
    ).rejects.toThrow("Text appears 2 times");

    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("x = 1\nx = 2\n");
  });

  test("can replace all text matches", async () => {
    const root = await createTempRoot();
    await writeFile(path.join(root, "notes.txt"), "x = 1\nx = 2\n");
    const edit = createEditTool({ root });
    const result = await edit.execute(
      {
        path: "notes.txt",
        oldText: "x",
        newText: "y",
        replaceAll: true,
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      path: "notes.txt",
      replacements: 2,
    });
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("y = 1\ny = 2\n");
  });
});
