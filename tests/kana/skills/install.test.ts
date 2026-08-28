import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installKanaSkills, reinstallKanaSkills } from "@/kana";
import {
  cleanupTempKanaHomes,
  createTempKanaHomeEnv as createTempEnv,
} from "../../helpers/temp-kana-home";

afterEach(cleanupTempKanaHomes);

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
    });
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
    });
    expect(calls).toEqual([
      {
        args: ["pull", "--ff-only"],
        cwd: skillsPath,
      },
    ]);
  });

  test("requires reinstall before replacing a non-git skills directory", async () => {
    const env = createTempEnv();
    const skillsPath = path.join(env.KANA_HOME, "skills", "kana-skills");
    mkdirSync(skillsPath, { recursive: true });
    writeFileSync(path.join(skillsPath, "SKILL.md"), "local skill");

    await expect(installKanaSkills(env, { runGit: createFakeGit([]) })).rejects.toThrow(
      `Cannot update skills because ${skillsPath} is not a git repository. Run kana skills reinstall to replace it.`,
    );
  });

  test("reinstall replaces only the default repository directory", async () => {
    const env = createTempEnv();
    const skillsPath = path.join(env.KANA_HOME, "skills", "kana-skills");
    mkdirSync(skillsPath, { recursive: true });
    writeFileSync(path.join(skillsPath, "old.txt"), "old checkout");
    const skillsConfigPath = path.join(env.KANA_HOME, "skills", "skills.toml");
    const personalSkillPath = path.join(env.KANA_HOME, "skills", "personal", "SKILL.md");
    writeFileSync(skillsConfigPath, 'enabled = ["personal"]\n');
    mkdirSync(path.dirname(personalSkillPath), { recursive: true });
    writeFileSync(personalSkillPath, "personal skill");
    const calls: GitCall[] = [];

    const result = await reinstallKanaSkills(env, {
      runGit: createFakeGit(calls),
    });

    expect(result).toEqual({
      skillsPath,
      status: "reinstalled",
    });
    expect(calls).toEqual([
      {
        args: ["clone", "https://github.com/longyijdos/kana-skills.git", skillsPath],
        cwd: undefined,
      },
    ]);
    expect(existsSync(skillsPath)).toBe(false);
    expect(readFileSync(skillsConfigPath, "utf8")).toBe('enabled = ["personal"]\n');
    expect(readFileSync(personalSkillPath, "utf8")).toBe("personal skill");
  });

  test("rejects repository names that could escape the Skills directory", async () => {
    await expect(
      reinstallKanaSkills(createTempEnv(), {
        repositoryName: "../outside",
        runGit: createFakeGit([]),
      }),
    ).rejects.toThrow("Skills repository name must be a single directory name.");
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
