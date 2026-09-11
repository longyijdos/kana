import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  resolveExistingWorkspaceDirectory,
  resolveExistingWorkspaceFile,
  resolveNewWorkspaceFile,
  resolveWorkspaceDirectory,
} from "../../src/tools/workspace-path";
import { createWorkspaceToolFixture } from "./workspace-fixture";

const { cleanupTempRoots, createTempRoot } = createWorkspaceToolFixture();

describe("workspace path resolution", () => {
  afterEach(cleanupTempRoots);

  test("resolves absolute files inside and outside the workspace", async () => {
    const root = await createTempRoot();
    const insideFile = path.join(root, "src", "main.ts");
    const outside = await createTempRoot();
    const outsideFile = path.join(outside, "secret.txt");
    await mkdir(path.dirname(insideFile), { recursive: true });
    await writeFile(insideFile, "inside");
    await writeFile(outsideFile, "outside");

    await expect(resolveExistingWorkspaceFile(root, insideFile)).resolves.toEqual({
      absolutePath: await realpath(insideFile),
      relativePath: path.join("src", "main.ts"),
    });
    await expect(resolveExistingWorkspaceFile(root, outsideFile)).resolves.toEqual({
      absolutePath: await realpath(outsideFile),
      relativePath: path.relative(root, outsideFile),
    });
  });

  test("canonicalizes symlinked existing files outside the workspace", async () => {
    const root = await createTempRoot();
    const outside = await createTempRoot();
    const outsideFile = path.join(outside, "secret.txt");
    await writeFile(outsideFile, "secret");
    await symlink(outsideFile, path.join(root, "secret-link.txt"));

    await expect(resolveExistingWorkspaceFile(root, "secret-link.txt")).resolves.toEqual({
      absolutePath: await realpath(outsideFile),
      relativePath: path.relative(root, outsideFile),
    });
  });

  test("resolves new outside files and canonicalizes symlinked parents", async () => {
    const root = await createTempRoot();
    const outside = await createTempRoot();
    const outsideFile = path.join(outside, "direct.txt");
    const linkedDirectory = path.join(root, "outside-link");
    const linkedInput = path.join("outside-link", "linked.txt");
    await symlink(outside, linkedDirectory);

    await expect(resolveNewWorkspaceFile(root, outsideFile)).resolves.toEqual({
      absolutePath: outsideFile,
      relativePath: path.relative(root, outsideFile),
    });
    await expect(resolveNewWorkspaceFile(root, linkedInput)).resolves.toEqual({
      absolutePath: path.join(await realpath(root), linkedInput),
      relativePath: path.relative(root, path.join(outside, "linked.txt")),
    });
  });

  test("expands a leading tilde to the home directory instead of the workspace", async () => {
    const root = await createTempRoot();
    const home = await realpath(homedir());
    const homeFile = path.join(home, "kana-tilde-resolution", "notes.txt");
    const resolved = await resolveNewWorkspaceFile(
      root,
      path.join("~", "kana-tilde-resolution", "notes.txt"),
    );

    expect(resolved.absolutePath).toBe(homeFile);
    expect(resolved.relativePath).toBe(path.relative(await realpath(root), homeFile));
    await expect(resolveExistingWorkspaceDirectory(root, "~")).resolves.toEqual({
      absolutePath: home,
      relativePath: path.relative(await realpath(root), home),
    });
    await expect(resolveWorkspaceDirectory(root, "~")).resolves.toEqual({
      absolutePath: home,
      relativePath: path.relative(await realpath(root), home),
    });
    expect(existsSync(path.join(root, "~"))).toBe(false);
  });

  test("keeps later tilde segments relative to the workspace", async () => {
    const root = await createTempRoot();
    const literalFile = path.join(root, "nested", "~", "notes.txt");
    await mkdir(path.dirname(literalFile), { recursive: true });
    await writeFile(literalFile, "literal");

    await expect(
      resolveExistingWorkspaceFile(root, path.join("nested", "~", "notes.txt")),
    ).resolves.toEqual({
      absolutePath: await realpath(literalFile),
      relativePath: path.join("nested", "~", "notes.txt"),
    });
  });
});
