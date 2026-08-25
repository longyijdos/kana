import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BackgroundJobManager } from "../../src/jobs";
import { createBashTool } from "../../src/tools/bash";
import { createEditTool } from "../../src/tools/edit";
import { createGlobTool } from "../../src/tools/glob";
import { createGrepTool } from "../../src/tools/grep";
import { createListTool } from "../../src/tools/list";
import { createReadTool } from "../../src/tools/read";
import type { ToolResult } from "../../src/tools/tool";
import { createViewImageTool } from "../../src/tools/view-image";
import { createWriteTool } from "../../src/tools/write";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const tempRoots: string[] = [];

describe("workspace tools", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  test("declares only read-only workspace tools as parallel", () => {
    const parallelTools = [
      createReadTool(),
      createListTool(),
      createGlobTool(),
      createGrepTool(),
      createViewImageTool(),
    ];
    const exclusiveByDefault = [createWriteTool(), createEditTool(), createBashTool()];

    expect(parallelTools.map((tool) => tool.execution?.concurrency)).toEqual([
      "parallel",
      "parallel",
      "parallel",
      "parallel",
      "parallel",
    ]);
    expect(exclusiveByDefault.map((tool) => tool.execution?.concurrency)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("view_image loads a workspace image as a visual tool observation", async () => {
    const root = await createTempRoot();
    const imagePath = path.join(root, "screenshots", "result.png");
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(imagePath, PNG_1X1);
    const viewImage = createViewImageTool({ root });

    const result = await viewImage.execute({ path: "screenshots/result.png" }, createToolContext());

    expectToolResult(result);
    expect(result.result).toEqual({
      path: path.join("screenshots", "result.png"),
      mimeType: "image/png",
      width: 1,
      height: 1,
      byteSize: 70,
    });
    expect(result.content).toContain("dimensions: 1x1");
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0]).toMatchObject({ mimeType: "image/png", width: 1, height: 1 });
    expect(Buffer.from(result.images?.[0]?.data ?? "", "base64").subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  test("view_image rejects paths that do not resolve to image files", async () => {
    const root = await createTempRoot();
    await mkdir(path.join(root, "screenshots"));
    const viewImage = createViewImageTool({ root });

    await expect(viewImage.execute({ path: "screenshots" }, createToolContext())).rejects.toThrow(
      "Path is not a file",
    );
  });

  test("read returns a line range from a workspace file", async () => {
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

  test("read accepts paths outside the workspace", async () => {
    const root = await createTempRoot();
    const outside = await createTempRoot();
    const outsideFile = path.join(outside, "secret.txt");
    await writeFile(outsideFile, "secret");
    const read = createReadTool({ root });
    const result = await read.execute(
      {
        path: outsideFile,
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      path: path.relative(root, outsideFile),
      content: "secret",
    });
  });

  test("read accepts symlinks that resolve outside the workspace", async () => {
    const root = await createTempRoot();
    const outside = await createTempRoot();
    const outsideFile = path.join(outside, "secret.txt");
    await writeFile(outsideFile, "secret");
    await symlink(outsideFile, path.join(root, "secret-link.txt"));
    const read = createReadTool({ root });
    const result = await read.execute(
      {
        path: "secret-link.txt",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      path: path.relative(root, outsideFile),
      content: "secret",
    });
  });

  test("list returns sorted direct directory entries", async () => {
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

  test("list can exclude hidden entries and truncate output", async () => {
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

  test("glob finds sorted files with hidden and depth filtering", async () => {
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

  test("glob can match directories and include hidden paths", async () => {
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

  test("glob rejects absolute and parent-directory patterns", async () => {
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

  test("grep searches file contents with regular expressions", async () => {
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

  test("grep searches directories with include patterns and hidden filtering", async () => {
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

  test("grep supports literal matching and accurate truncation", async () => {
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

  test("grep rejects invalid regex and include patterns", async () => {
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
    expect(await readFile(path.join(root, "src", "generated", "file.ts"), "utf8")).toBe(
      "export const value = 1;\n",
    );
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

  test("write overwrites existing files when requested", async () => {
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

  test("write rejects existing directories even when overwrite is requested", async () => {
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

  test("write creates paths outside the workspace", async () => {
    const root = await createTempRoot();
    const outside = await createTempRoot();
    const filePath = path.join(outside, "created.txt");
    const write = createWriteTool({ root });
    const result = await write.execute(
      {
        path: filePath,
        content: "secret",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      path: path.relative(root, filePath),
    });
    expect(await readFile(filePath, "utf8")).toBe("secret");
  });

  test("write creates paths under symlinked directories outside the workspace", async () => {
    const root = await createTempRoot();
    const outside = await createTempRoot();
    await symlink(outside, path.join(root, "outside-link"));
    const write = createWriteTool({ root });
    const result = await write.execute(
      {
        path: path.join("outside-link", "created.txt"),
        content: "secret",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(await readFile(path.join(outside, "created.txt"), "utf8")).toBe("secret");
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

  test("edit accepts paths outside the workspace", async () => {
    const root = await createTempRoot();
    const outside = await createTempRoot();
    const outsideFile = path.join(outside, "secret.txt");
    await writeFile(outsideFile, "secret");
    const edit = createEditTool({ root });
    const result = await edit.execute(
      {
        path: outsideFile,
        oldText: "secret",
        newText: "public",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      path: path.relative(root, outsideFile),
      replacements: 1,
    });
    expect(await readFile(outsideFile, "utf8")).toBe("public");
  });

  test("edit accepts symlinks that resolve outside the workspace", async () => {
    const root = await createTempRoot();
    const outside = await createTempRoot();
    const outsideFile = path.join(outside, "secret.txt");
    await writeFile(outsideFile, "secret");
    await symlink(outsideFile, path.join(root, "secret-link.txt"));
    const edit = createEditTool({ root });
    const result = await edit.execute(
      {
        path: "secret-link.txt",
        oldText: "secret",
        newText: "public",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      path: path.relative(root, outsideFile),
      replacements: 1,
    });
    expect(await readFile(outsideFile, "utf8")).toBe("public");
  });

  test("bash runs a command inside the workspace", async () => {
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

  test("bash preserves non-zero command exits without marking the tool as an error", async () => {
    const root = await createTempRoot();
    const bash = createBashTool({ root });
    const result = await bash.execute(
      {
        command: "printf command-failed >&2; exit 7",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      exitCode: 7,
      stderr: "command-failed",
      timedOut: false,
    });
    expect(result.isError).toBe(false);
  });

  test("bash streams stdout before the command completes", async () => {
    const root = await createTempRoot();
    const updates: unknown[] = [];
    const bash = createBashTool({ root });
    let completed = false;
    const execution = Promise.resolve(
      bash.execute(
        {
          command: "printf start; sleep 1; printf end",
        },
        createToolContext(updates),
      ),
    ).finally(() => {
      completed = true;
    });

    await waitForCondition(() => updates.length > 0);

    expect(completed).toBe(false);
    expect(updates[0]).toMatchObject({
      command: "printf start; sleep 1; printf end",
      cwd: ".",
      stdout: "start",
      stderr: "",
    });
    expect(updates[0]).not.toHaveProperty("exitCode");

    const result = await execution;

    expectToolResult(result);
    expect(result.result).toMatchObject({
      exitCode: 0,
      stdout: "startend",
    });
  });

  test("bash streams stderr output", async () => {
    const root = await createTempRoot();
    const updates: unknown[] = [];
    const bash = createBashTool({ root });
    const result = await bash.execute(
      {
        command: "printf problem >&2",
      },
      createToolContext(updates),
    );

    expectToolResult(result);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.at(-1)).toMatchObject({
      stderr: "problem",
    });
  });

  test("bash preserves complete final output and bounds live updates to a trailing snapshot", async () => {
    const root = await createTempRoot();
    const updates: unknown[] = [];
    const bash = createBashTool({ root });
    const fullStdout = `prefix-${"x".repeat(25_000)}-suffix`;
    const result = await bash.execute(
      {
        command: `printf %s ${shellQuote(fullStdout)}`,
      },
      createToolContext(updates),
    );

    expectToolResult(result);
    expect(result.result.stdout).toBe(fullStdout);
    expect(result.result).not.toHaveProperty("stdoutTruncated");
    expect(result.result).not.toHaveProperty("stderrTruncated");
    expect(updates.at(-1)).toMatchObject({
      stdout: fullStdout.slice(-20_000),
    });
    expect(updates.at(-1)).not.toHaveProperty("stdoutTruncated");
    expect(updates.at(-1)).not.toHaveProperty("stderrTruncated");
  });

  test("bash runs commands with stdin disconnected", async () => {
    const root = await createTempRoot();
    const bash = createBashTool({ root });
    const result = await bash.execute(
      {
        command: 'if read -t 1 value; then printf "read:%s" "$value"; else printf no-stdin; fi',
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      exitCode: 0,
      stdout: "no-stdin",
    });
  });

  test("bash makes sudo non-interactive by default", async () => {
    const root = await createTempRoot();
    const sudoPath = path.join(root, "sudo");
    await writeFile(
      sudoPath,
      ["#!/usr/bin/env bash", 'printf "%s\\n" "$@" > sudo-args.txt', "printf fake-sudo", ""].join(
        "\n",
      ),
    );
    await chmod(sudoPath, 0o755);
    const bash = createBashTool({ root });
    const result = await bash.execute(
      {
        command: `PATH=${shellQuote(root)}:$PATH sudo id`,
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      exitCode: 0,
      stdout: "fake-sudo",
    });
    expect(await readFile(path.join(root, "sudo-args.txt"), "utf8")).toBe("-n\nid\n");
  });

  test("bash can run commands through a configured shell", async () => {
    const root = await createTempRoot();
    const shellPath = path.join(root, "custom-shell");
    await writeFile(
      shellPath,
      [
        "#!/usr/bin/env bash",
        "export KANA_CUSTOM_SHELL=from-custom-shell",
        'exec bash "$@"',
        "",
      ].join("\n"),
    );
    await chmod(shellPath, 0o755);
    const bash = createBashTool({ root, shell: shellPath });
    const result = await bash.execute(
      {
        command: 'printf %s "$KANA_CUSTOM_SHELL"',
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      exitCode: 0,
      stdout: "from-custom-shell",
    });
  });

  test("bash inherits environment variables added after process startup", async () => {
    const root = await createTempRoot();
    const envName = `KANA_TEST_BASH_RUNTIME_${process.pid}`;
    const previous = process.env[envName];
    process.env[envName] = "from-runtime";

    try {
      const bash = createBashTool({ root });
      const result = await bash.execute(
        {
          command: `printf %s "$${envName}"`,
        },
        createToolContext(),
      );

      expectToolResult(result);
      expect(result.result).toMatchObject({
        exitCode: 0,
        stdout: "from-runtime",
      });
    } finally {
      if (previous === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = previous;
      }
    }
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

  test("bash allows shell control operators", async () => {
    const root = await createTempRoot();
    await writeFile(path.join(root, "notes.txt"), "hello\n");
    const bash = createBashTool({ root });
    const result = await bash.execute(
      {
        command: "cat notes.txt; printf done",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      exitCode: 0,
      stdout: "hello\ndone",
    });
  });

  test("bash allows arbitrary commands", async () => {
    const root = await createTempRoot();
    const filePath = path.join(root, "notes.txt");
    await writeFile(filePath, "hello\n");
    const bash = createBashTool({ root });
    const result = await bash.execute(
      {
        command: "rm notes.txt",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      exitCode: 0,
    });
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
  });

  test("bash allows git history-changing commands", async () => {
    const root = await createTempRoot();
    const bash = createBashTool({ root });
    const result = await bash.execute(
      {
        command: "git reset --hard",
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      command: "git reset --hard",
    });
  });

  test("bash accepts cwd outside the workspace", async () => {
    const root = await createTempRoot();
    const outside = await createTempRoot();
    await writeFile(path.join(outside, "notes.txt"), "outside\n");
    const bash = createBashTool({ root });
    const result = await bash.execute(
      {
        command: "cat notes.txt",
        cwd: outside,
      },
      createToolContext(),
    );

    expectToolResult(result);
    expect(result.result).toMatchObject({
      cwd: path.relative(root, outside),
      stdout: "outside\n",
    });
  });

  test("bash starts a session-owned background Job and streams its output separately", async () => {
    const root = await createTempRoot();
    const manager = new BackgroundJobManager();
    const jobs = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 1 });
    const bash = createBashTool({ root, backgroundJobs: jobs });
    const result = await bash.execute(
      {
        command: "printf start; sleep 0.1; printf end",
        background: true,
      },
      createToolContext(),
    );
    expectToolResult(result);
    const jobId = result.result.jobId;

    expect(result.result).toMatchObject({
      background: true,
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      status: "running",
    });
    expect(jobId).toStartWith("job_");
    const output = await readJobToCompletion(jobs, jobId ?? "");
    expect(output).toBe("startend");
    expect(jobs.list()[0]).toMatchObject({ status: "completed", exitCode: 0 });
    await manager.close();
  });

  test("bash rejects background execution without a session Job client", async () => {
    const root = await createTempRoot();
    const bash = createBashTool({ root });

    await expect(
      bash.execute({ command: "sleep 1", background: true }, createToolContext()),
    ).rejects.toThrow("Background Bash is unavailable without an active session.");
  });

  test("bash keeps raw shell backgrounding inside the foreground process lifetime", async () => {
    const root = await createTempRoot();
    const sideEffectPath = path.join(root, "escaped.txt");
    const sideEffectDelaySeconds = 1;
    const bash = createBashTool({ root });
    const result = await bash.execute(
      {
        command: `(sleep ${sideEffectDelaySeconds}; printf escaped > ${shellQuote(sideEffectPath)}) & printf foreground`,
        timeoutMs: 100,
      },
      createToolContext(),
    );
    expectToolResult(result);

    expect(result.result).toMatchObject({
      exitCode: null,
      timedOut: true,
    });
    await new Promise((resolve) => setTimeout(resolve, sideEffectDelaySeconds * 1_000 + 100));
    expect(existsSync(sideEffectPath)).toBe(false);
  });

  test("bash cancellation terminates background children in the command process group", async () => {
    const root = await createTempRoot();
    const pidPath = path.join(root, "background.pid");
    const bash = createBashTool({ root });
    const controller = new AbortController();
    const execution = bash.execute(
      {
        command: `sleep 30 & printf %s "$!" > ${shellQuote(pidPath)}; wait`,
      },
      {
        ...createToolContext(),
        signal: controller.signal,
      },
    );

    await waitForCondition(() => existsSync(pidPath));
    controller.abort();

    await expect(execution).rejects.toThrow("Command aborted.");
    const pid = Number(await readFile(pidPath, "utf8"));
    await waitForCondition(() => !isProcessRunning(pid));
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

function createToolContext(updates: unknown[] = []) {
  return {
    toolCallId: "call_1",
    update(partialResult: unknown) {
      updates.push(partialResult);
    },
  };
}

function expectToolResult<T>(value: unknown): asserts value is ToolResult<T> {
  expect(value).toBeObject();
  expect(value).toHaveProperty("content");
  expect(value).toHaveProperty("result");
}

async function waitForCondition(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for condition.");
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function readJobToCompletion(
  jobs: import("../../src/jobs").BackgroundJobClient,
  jobId: string,
): Promise<string> {
  let output = "";
  for (;;) {
    const snapshot = await jobs.read(jobId, { waitMs: 1_000 });
    output += snapshot.chunks.map((chunk) => chunk.text).join("");
    if (snapshot.status !== "running" && snapshot.status !== "stopping" && !snapshot.hasMore) {
      return output;
    }
  }
}
