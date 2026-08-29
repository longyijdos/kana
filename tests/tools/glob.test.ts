import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGlobTool } from "../../src/tools/glob";
import {
  createToolContext,
  createWorkspaceToolFixture,
  expectToolResult,
} from "./workspace-fixture";

const { cleanupTempRoots, createTempRoot } = createWorkspaceToolFixture();

describe("glob tool", () => {
  afterEach(cleanupTempRoots);

  test("finds sorted files with hidden and depth filtering", async () => {
    const root = await createTempRoot();
    await mkdir(path.join(root, "src", "nested"), { recursive: true });
    await mkdir(path.join(root, ".hidden"), { recursive: true });
    await writeFile(path.join(root, "src", "main.ts"), "export {}\n");
    await writeFile(path.join(root, "src", "nested", "deep.ts"), "export {}\n");
    await writeFile(path.join(root, ".hidden", "secret.ts"), "export {}\n");
    const glob = createGlobTool({ root });
    const result = await glob.execute(
      {
        pattern: "**/*.ts",
        maxDepth: 2,
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      cwd: ".",
      pattern: "**/*.ts",
      type: "file",
      totalMatches: 1,
      truncated: false,
    });
    expect(result.result.matches).toEqual([
      expect.objectContaining({ path: path.join("src", "main.ts"), type: "file" }),
    ]);
    expect(result.content).toContain("matches: 1 of 1");
  });

  test("can match directories and include hidden paths", async () => {
    const root = await createTempRoot();
    await mkdir(path.join(root, ".config"));
    await mkdir(path.join(root, "src"));
    const glob = createGlobTool({ root });
    const result = await glob.execute(
      {
        pattern: "*",
        type: "directory",
        includeHidden: true,
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result.matches).toEqual([
      expect.objectContaining({ path: ".config", type: "directory" }),
      expect.objectContaining({ path: "src", type: "directory" }),
    ]);
  });

  test("rejects absolute and parent-directory patterns", async () => {
    const root = await createTempRoot();
    const glob = createGlobTool({ root });

    await expect(
      glob.execute(
        {
          pattern: "/tmp/**/*",
        },
        createToolContext(),
      ),
    ).rejects.toThrow("Invalid glob pattern.");
    await expect(
      glob.execute(
        {
          pattern: "../**/*",
        },
        createToolContext(),
      ),
    ).rejects.toThrow("Invalid glob pattern.");
  });
});
