import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { getKanaConfigPaths } from "./config";

const execFileAsync = promisify(execFile);

export const DEFAULT_KANA_SKILLS_REPOSITORY =
  "https://github.com/longyijdos/kana-skills.git";
export const DEFAULT_KANA_SKILLS_REPOSITORY_NAME = "kana-skills";

export type InstallKanaSkillsOptions = {
  force?: boolean;
  repositoryUrl?: string;
  repositoryName?: string;
  runGit?: GitRunner;
};

export type InstallKanaSkillsResult = {
  skillsPath: string;
  status: "cloned" | "updated" | "reinstalled";
};

type GitRunner = (args: string[], options?: { cwd?: string }) => Promise<void>;

export async function installKanaSkills(
  env: NodeJS.ProcessEnv = process.env,
  options: InstallKanaSkillsOptions = {},
): Promise<InstallKanaSkillsResult> {
  const repositoryUrl = options.repositoryUrl ?? DEFAULT_KANA_SKILLS_REPOSITORY;
  const repositoryName =
    options.repositoryName ?? DEFAULT_KANA_SKILLS_REPOSITORY_NAME;
  const { home } = getKanaConfigPaths(env);
  const skillsPath = path.join(home, "skills", repositoryName);
  const runGit = options.runGit ?? runGitCommand;

  if (!existsSync(skillsPath)) {
    mkdirSync(path.dirname(skillsPath), { recursive: true });
    await runGit(["clone", repositoryUrl, skillsPath]);
    return {
      skillsPath,
      status: "cloned",
    };
  }

  if (options.force) {
    rmSync(skillsPath, { recursive: true, force: true });
    mkdirSync(path.dirname(skillsPath), { recursive: true });
    await runGit(["clone", repositoryUrl, skillsPath]);
    return {
      skillsPath,
      status: "reinstalled",
    };
  }

  if (!isDirectory(path.join(skillsPath, ".git"))) {
    throw new Error(
      `Cannot update skills because ${skillsPath} is not a git repository. Re-run with --force to replace it.`,
    );
  }

  await runGit(["pull", "--ff-only"], { cwd: skillsPath });
  return {
    skillsPath,
    status: "updated",
  };
}

async function runGitCommand(
  args: string[],
  options: { cwd?: string } = {},
): Promise<void> {
  try {
    await execFileAsync("git", args, {
      cwd: options.cwd,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed: ${formatError(error)}`);
  }
}

function isDirectory(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
