import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGrepTool } from "../../src/tools/grep";
import {
  createToolContext,
  createWorkspaceToolFixture,
  expectToolResult,
} from "./workspace-fixture";

const { cleanupTempRoots, createTempRoot } = createWorkspaceToolFixture();

describe("grep tool", () => {
  afterEach(cleanupTempRoots);

  test("searches file contents with regular expressions", async () => {
    const root = await createTempRoot();
    await writeFile(
      path.join(root, "query.ts"),
      [
        "const autocompact = true;",
        "const unrelated = true;",
        "query.compact();",
        "compactlyIgnored();",
      ].join("\n"),
    );
    const grep = createGrepTool({ root });
    const result = await grep.execute(
      {
        path: "query.ts",
        pattern: "autocompact|\\.compact\\b",
        limit: 20,
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      path: "query.ts",
      pattern: "autocompact|\\.compact\\b",
      literal: false,
      caseSensitive: true,
      filesSearched: 1,
      truncated: false,
    });
    expect(result.result.matches).toEqual([
      {
        path: "query.ts",
        line: 1,
        column: 7,
        text: "const autocompact = true;",
      },
      {
        path: "query.ts",
        line: 3,
        column: 6,
        text: "query.compact();",
      },
    ]);
    expect(result.content).toContain("query.ts:1:7:const autocompact = true;");
  });

  test("searches directories with include patterns and hidden filtering", async () => {
    const root = await createTempRoot();
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, ".hidden"));
    await writeFile(path.join(root, "src", "one.ts"), "needle\n");
    await writeFile(path.join(root, "src", "two.md"), "needle\n");
    await writeFile(path.join(root, ".hidden", "secret.ts"), "needle\n");
    const grep = createGrepTool({ root });
    const result = await grep.execute(
      {
        path: ".",
        pattern: "needle",
        include: "**/*.ts",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      path: ".",
      include: "**/*.ts",
      filesSearched: 1,
      truncated: false,
    });
    expect(result.result.matches).toEqual([
      {
        path: path.join("src", "one.ts"),
        line: 1,
        column: 1,
        text: "needle",
      },
    ]);
  });

  test("supports literal matching and accurate truncation", async () => {
    const root = await createTempRoot();
    await writeFile(path.join(root, "notes.txt"), ["a.b", "axb", "a.b again"].join("\n"));
    const grep = createGrepTool({ root });
    const exactLimit = await grep.execute(
      {
        path: "notes.txt",
        pattern: "a.b",
        literal: true,
        limit: 2,
      },
      createToolContext(),
    );
    const truncated = await grep.execute(
      {
        path: "notes.txt",
        pattern: "a",
        limit: 2,
      },
      createToolContext(),
    );

    expectToolResult(exactLimit);
    expect(exactLimit.result.matches).toHaveLength(2);
    expect(exactLimit.result.truncated).toBe(false);
    expectToolResult(truncated);
    expect(truncated.result.matches).toHaveLength(2);
    expect(truncated.result.truncated).toBe(true);
  });

  test("rejects invalid regex and include patterns", async () => {
    const root = await createTempRoot();
    await writeFile(path.join(root, "notes.txt"), "hello\n");
    const grep = createGrepTool({ root });

    await expect(
      grep.execute(
        {
          path: "notes.txt",
          pattern: "[",
        },
        createToolContext(),
      ),
    ).rejects.toThrow("Invalid grep pattern:");
    await expect(
      grep.execute(
        {
          path: ".",
          pattern: "hello",
          include: "../**/*",
        },
        createToolContext(),
      ),
    ).rejects.toThrow("Invalid grep include pattern.");
  });
});
