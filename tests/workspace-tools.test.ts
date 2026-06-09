import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createBashTool } from "../src/tools/bash";
import { createEditTool } from "../src/tools/edit";
import { createReadTool } from "../src/tools/read";
import { createWriteTool } from "../src/tools/write";
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

  test("write creates a new workspace file", async () => {
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

  test("write creates missing parent directories", async () => {
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
    expect(await readFile(path.join(root, "src", "generated", "file.ts"), "utf8"))
      .toBe("export const value = 1;\n");
  });

  test("write rejects existing paths", async () => {
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

  test("write rejects paths outside the workspace", async () => {
    const root = await createTempRoot();
    const outside = await createTempRoot();
    const write = createWriteTool({ root });

    await expect(
      write.execute(
        {
          path: path.join(outside, "created.txt"),
          content: "secret",
        },
        createToolContext(),
      ),
    ).rejects.toThrow("Path is outside the workspace");
  });

  test("write rejects paths under symlinked directories outside the workspace", async () => {
    const root = await createTempRoot();
    const outside = await createTempRoot();
    await symlink(outside, path.join(root, "outside-link"));
    const write = createWriteTool({ root });

    await expect(
      write.execute(
        {
          path: path.join("outside-link", "created.txt"),
          content: "secret",
        },
        createToolContext(),
      ),
    ).rejects.toThrow("Path is outside the workspace");
  });

  test("edit replaces a unique text match in an existing file", async () => {
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

  test("edit rejects missing old text", async () => {
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

  test("edit rejects repeated old text unless replaceAll is true", async () => {
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

  test("edit can replace all text matches", async () => {
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

  test("edit rejects paths outside the workspace", async () => {
    const root = await createTempRoot();
    const outside = await createTempRoot();
    const outsideFile = path.join(outside, "secret.txt");
    await writeFile(outsideFile, "secret");
    const edit = createEditTool({ root });

    await expect(
      edit.execute(
        {
          path: outsideFile,
          oldText: "secret",
          newText: "public",
        },
        createToolContext(),
      ),
    ).rejects.toThrow("Path is outside the workspace");
  });

  test("edit rejects symlinks that resolve outside the workspace", async () => {
    const root = await createTempRoot();
    const outside = await createTempRoot();
    const outsideFile = path.join(outside, "secret.txt");
    await writeFile(outsideFile, "secret");
    await symlink(outsideFile, path.join(root, "secret-link.txt"));
    const edit = createEditTool({ root });

    await expect(
      edit.execute(
        {
          path: "secret-link.txt",
          oldText: "secret",
          newText: "public",
        },
        createToolContext(),
      ),
    ).rejects.toThrow("Path is outside the workspace");
  });

  test("bash runs an allowlisted command inside the workspace", async () => {
    const root = await createTempRoot();
    await writeFile(path.join(root, "notes.txt"), "hello\n");
    const bash = createBashTool({ root });
    const result = await bash.execute(
      {
        command: "cat notes.txt",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      command: "cat notes.txt",
      cwd: ".",
      exitCode: 0,
      stdout: "hello\n",
      stderr: "",
      timedOut: false,
    });
    expect(result.isError).toBe(false);
  });

  test("bash runs from a workspace subdirectory", async () => {
    const root = await createTempRoot();
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "notes.txt"), "hello\n");
    const bash = createBashTool({ root });
    const result = await bash.execute(
      {
        command: "cat notes.txt",
        cwd: "src",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      cwd: "src",
      stdout: "hello\n",
    });
  });

  test("bash rejects shell control operators", async () => {
    const root = await createTempRoot();
    const bash = createBashTool({ root });

    await expect(
      bash.execute(
        {
          command: "cat notes.txt; rm notes.txt",
        },
        createToolContext(),
      ),
    ).rejects.toThrow("Shell control operators are not allowed");
  });

  test("bash rejects non-allowlisted commands", async () => {
    const root = await createTempRoot();
    const bash = createBashTool({ root });

    await expect(
      bash.execute(
        {
          command: "rm notes.txt",
        },
        createToolContext(),
      ),
    ).rejects.toThrow("Command is not allowlisted: rm");
  });

  test("bash rejects unsafe git subcommands", async () => {
    const root = await createTempRoot();
    const bash = createBashTool({ root });

    await expect(
      bash.execute(
        {
          command: "git reset --hard",
        },
        createToolContext(),
      ),
    ).rejects.toThrow("Command is not allowlisted: git reset");
  });

  test("bash rejects cwd outside the workspace", async () => {
    const root = await createTempRoot();
    const outside = await createTempRoot();
    const bash = createBashTool({ root });

    await expect(
      bash.execute(
        {
          command: "pwd",
          cwd: outside,
        },
        createToolContext(),
      ),
    ).rejects.toThrow("Working directory is outside the workspace");
  });

  test("bash reports timeouts", async () => {
    const root = await createTempRoot();
    const bash = createBashTool({ root });
    const result = await bash.execute(
      {
        command: "find .",
        timeoutMs: 1,
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      exitCode: null,
      timedOut: true,
    });
    expect(result.isError).toBe(true);
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
