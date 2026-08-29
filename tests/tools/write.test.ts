import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createWriteTool } from "../../src/tools/write";
import {
  createToolContext,
  createWorkspaceToolFixture,
  expectToolResult,
} from "./workspace-fixture";

const { cleanupTempRoots, createTempRoot } = createWorkspaceToolFixture();

describe("write tool", () => {
  afterEach(cleanupTempRoots);

  test("creates a new workspace file", async () => {
    const root = await createTempRoot();
    const write = createWriteTool({ root });
    const result = await write.execute(
      {
        path: "notes.txt",
        content: "hello\n",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toEqual({
      path: "notes.txt",
      bytesWritten: 6,
    });
    expect(result.content).toContain("wrote: notes.txt");
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("hello\n");
  });

  test("creates missing parent directories", async () => {
    const root = await createTempRoot();
    const write = createWriteTool({ root });
    const result = await write.execute(
      {
        path: "src/generated/file.ts",
        content: "export const value = 1;\n",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      path: path.join("src", "generated", "file.ts"),
    });
    expect(await readFile(path.join(root, "src", "generated", "file.ts"), "utf8")).toBe(
      "export const value = 1;\n",
    );
  });

  test("rejects existing paths", async () => {
    const root = await createTempRoot();
    await writeFile(path.join(root, "notes.txt"), "existing");
    const write = createWriteTool({ root });

    await expect(
      write.execute(
        {
          path: "notes.txt",
          content: "new",
        },
        createToolContext(),
      ),
    ).rejects.toThrow("Path already exists");

    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("existing");
  });

  test("overwrites existing files when requested", async () => {
    const root = await createTempRoot();
    await writeFile(path.join(root, "notes.txt"), "existing");
    const write = createWriteTool({ root });
    const result = await write.execute(
      {
        path: "notes.txt",
        content: "replacement\n",
        overwrite: true,
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toEqual({
      path: "notes.txt",
      bytesWritten: 12,
    });
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("replacement\n");
  });

  test("rejects existing directories even when overwrite is requested", async () => {
    const root = await createTempRoot();
    await mkdir(path.join(root, "notes"));
    const write = createWriteTool({ root });

    await expect(
      write.execute(
        {
          path: "notes",
          content: "new",
          overwrite: true,
        },
        createToolContext(),
      ),
    ).rejects.toThrow("Path is not a file");
  });
});
