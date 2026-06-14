import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { installKanaSkills } from "@/kana";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Kana skill installation", () => {
  test("clones the default skills repository under ~/.kana/skills", async () => {
    const env = createTempEnv();
    const calls: GitCall[] = [];

    const result = await installKanaSkills(env, {
      runGit: createFakeGit(calls),
    });

    expect(result).toEqual({
      skillsPath: path.join(env.KANA_HOME, "skills", "kana-skills"),
      status: "cloned",
      skillsConfigPath: path.join(env.KANA_HOME, "skills", "skills.toml"),
      skillsConfigStatus: "created",
    });
    expect(existsSync(path.join(env.KANA_HOME, "skills"))).toBe(true);
    expect(readFileSync(result.skillsConfigPath, "utf8")).toBe(
      ["[model_invocation]", "enabled = []", ""].join("\n"),
    );
    expect(calls).toEqual([
      {
        args: [
          "clone",
          "https://github.com/longyijdos/kana-skills.git",
          path.join(env.KANA_HOME, "skills", "kana-skills"),
        ],
        cwd: undefined,
      },
    ]);
  });

  test("updates an existing skills checkout", async () => {
    const env = createTempEnv();
    const skillsPath = path.join(env.KANA_HOME, "skills", "kana-skills");
    mkdirSync(path.join(skillsPath, ".git"), { recursive: true });
    const calls: GitCall[] = [];

    const result = await installKanaSkills(env, {
      runGit: createFakeGit(calls),
    });

    expect(result).toEqual({
      skillsPath,
      status: "updated",
      skillsConfigPath: path.join(env.KANA_HOME, "skills", "skills.toml"),
      skillsConfigStatus: "created",
    });
    expect(calls).toEqual([
      {
        args: ["pull", "--ff-only"],
        cwd: skillsPath,
      },
    ]);
  });

  test("requires force before replacing a non-git skills directory", async () => {
    const env = createTempEnv();
    const skillsPath = path.join(env.KANA_HOME, "skills", "kana-skills");
    const skillsConfigPath = path.join(env.KANA_HOME, "skills", "skills.toml");
    mkdirSync(skillsPath, { recursive: true });
    writeFileSync(path.join(skillsPath, "SKILL.md"), "local skill");

    await expect(installKanaSkills(env, { runGit: createFakeGit([]) })).rejects
      .toThrow(
        `Cannot update skills because ${skillsPath} is not a git repository. Re-run with --force to replace it.`,
      );
    expect(existsSync(skillsConfigPath)).toBe(false);
  });

  test("keeps an existing skills config without force", async () => {
    const env = createTempEnv();
    const skillsPath = path.join(env.KANA_HOME, "skills", "kana-skills");
    const skillsConfigPath = path.join(env.KANA_HOME, "skills", "skills.toml");
    mkdirSync(path.join(skillsPath, ".git"), { recursive: true });
    writeFileSync(
      skillsConfigPath,
      ["[model_invocation]", 'enabled = ["existing"]', ""].join("\n"),
    );

    const result = await installKanaSkills(env, {
      runGit: createFakeGit([]),
    });

    expect(result.skillsConfigPath).toBe(skillsConfigPath);
    expect(result.skillsConfigStatus).toBe("exists");
    expect(readFileSync(skillsConfigPath, "utf8")).toBe(
      ["[model_invocation]", 'enabled = ["existing"]', ""].join("\n"),
    );
  });

  test("force reinstalls an existing skills checkout", async () => {
    const env = createTempEnv();
    const skillsPath = path.join(env.KANA_HOME, "skills", "kana-skills");
    const skillsConfigPath = path.join(env.KANA_HOME, "skills", "skills.toml");
    mkdirSync(skillsPath, { recursive: true });
    writeFileSync(
      skillsConfigPath,
      ["[model_invocation]", 'enabled = ["existing"]', ""].join("\n"),
    );
    const calls: GitCall[] = [];

    const result = await installKanaSkills(env, {
      force: true,
      runGit: createFakeGit(calls),
    });

    expect(result).toEqual({
      skillsPath,
      status: "reinstalled",
      skillsConfigPath,
      skillsConfigStatus: "reinstalled",
    });
    expect(readFileSync(skillsConfigPath, "utf8")).toBe(
      ["[model_invocation]", "enabled = []", ""].join("\n"),
    );
    expect(calls).toEqual([
      {
        args: [
          "clone",
          "https://github.com/longyijdos/kana-skills.git",
          skillsPath,
        ],
        cwd: undefined,
      },
    ]);
  });
});

type GitCall = {
  args: string[];
  cwd: string | undefined;
};

function createFakeGit(calls: GitCall[]) {
  return async (args: string[], options: { cwd?: string } = {}) => {
    calls.push({
      args,
      cwd: options.cwd,
    });
  };
}

function createTempEnv(): NodeJS.ProcessEnv & { KANA_HOME: string } {
  const tempDir = mkdtempSync(path.join(tmpdir(), "kana-skill-install-"));
  tempDirs.push(tempDir);

  return {
    KANA_HOME: path.join(tempDir, ".kana"),
  };
}
