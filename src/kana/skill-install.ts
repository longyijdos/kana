import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { getKanaConfigPaths } from "./config";
import { formatError } from "./format";

const execFileAsync = promisify(execFile);

export const DEFAULT_KANA_SKILLS_REPOSITORY = "https://github.com/longyijdos/kana-skills.git";
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
  skillsConfigPath: string;
  skillsConfigStatus: "created" | "exists" | "reinstalled";
};

type GitRunner = (args: string[], options?: { cwd?: string }) => Promise<void>;

export async function installKanaSkills(
  env: NodeJS.ProcessEnv = process.env,
  options: InstallKanaSkillsOptions = {},
): Promise<InstallKanaSkillsResult> {
  const repositoryUrl = options.repositoryUrl ?? DEFAULT_KANA_SKILLS_REPOSITORY;
  const repositoryName = options.repositoryName ?? DEFAULT_KANA_SKILLS_REPOSITORY_NAME;
  const { home } = getKanaConfigPaths(env);
  const skillsRoot = path.join(home, "skills");
  const skillsPath = path.join(skillsRoot, repositoryName);
  const runGit = options.runGit ?? runGitCommand;
  let status: InstallKanaSkillsResult["status"];

  if (!existsSync(skillsPath)) {
    mkdirSync(path.dirname(skillsPath), { recursive: true });
    await runGit(["clone", repositoryUrl, skillsPath]);
    status = "cloned";
  } else if (options.force) {
    rmSync(skillsPath, { recursive: true, force: true });
    mkdirSync(path.dirname(skillsPath), { recursive: true });
    await runGit(["clone", repositoryUrl, skillsPath]);
    status = "reinstalled";
  } else if (!isDirectory(path.join(skillsPath, ".git"))) {
    throw new Error(
      `Cannot update skills because ${skillsPath} is not a git repository. Re-run with --force to replace it.`,
    );
  } else {
    await runGit(["pull", "--ff-only"], { cwd: skillsPath });
    status = "updated";
  }

  return {
    skillsPath,
    status,
    ...installKanaSkillsConfig(skillsRoot, options.force),
  };
}

function installKanaSkillsConfig(
  skillsRoot: string,
  force: boolean | undefined,
): Pick<InstallKanaSkillsResult, "skillsConfigPath" | "skillsConfigStatus"> {
  const skillsConfigPath = path.join(skillsRoot, "skills.toml");
  const exists = existsSync(skillsConfigPath);

  if (!exists || force) {
    mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(skillsConfigPath, ["[model_invocation]", "enabled = []", ""].join("\n"), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  return {
    skillsConfigPath,
    skillsConfigStatus: exists && !force ? "exists" : exists ? "reinstalled" : "created",
  };
}

async function runGitCommand(args: string[], options: { cwd?: string } = {}): Promise<void> {
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
