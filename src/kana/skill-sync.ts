import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { getKanaConfigPaths } from "./config";
import { DEFAULT_KANA_SKILLS_REPOSITORY_NAME } from "./skill-install";

export const KANA_SKILL_SYNC_TARGETS = ["codex"] as const;

export type KanaSkillSyncTarget = (typeof KANA_SKILL_SYNC_TARGETS)[number];

export type SyncKanaSkillsOptions = {
  repositoryName?: string;
  targetAgent?: string;
  targetDir?: string;
};

export type ResyncKanaSkillsOptions = SyncKanaSkillsOptions;

export type SyncKanaSkillStatus = "copied" | "exists" | "replaced";

export type SyncKanaSkillResult = {
  name: string;
  sourcePath: string;
  status: SyncKanaSkillStatus;
  targetPath: string;
};

export type SyncKanaSkillsResult = {
  sourcePath: string;
  targetName: string;
  targetPath: string;
  skills: SyncKanaSkillResult[];
};

type SourceSkillDirectory = {
  name: string;
  sourcePath: string;
};

export function syncKanaSkills(
  env: NodeJS.ProcessEnv = process.env,
  options: SyncKanaSkillsOptions = {},
): SyncKanaSkillsResult {
  return copyKanaSkills(env, options, false);
}

export function resyncKanaSkills(
  env: NodeJS.ProcessEnv = process.env,
  options: ResyncKanaSkillsOptions = {},
): SyncKanaSkillsResult {
  return copyKanaSkills(env, options, true);
}

function copyKanaSkills(
  env: NodeJS.ProcessEnv,
  options: SyncKanaSkillsOptions,
  replaceExisting: boolean,
): SyncKanaSkillsResult {
  const repositoryName = options.repositoryName ?? DEFAULT_KANA_SKILLS_REPOSITORY_NAME;
  const sourcePath = path.join(getKanaConfigPaths(env).home, "skills", repositoryName);
  let targetName: KanaSkillSyncTarget | "custom";
  let targetPath: string;

  if (options.targetDir) {
    targetName = "custom";
    targetPath = path.resolve(options.targetDir);
  } else {
    targetName = readTargetAgent(options.targetAgent);
    targetPath = getPresetTargetPath(targetName, env);
  }

  const resolvedSourcePath = path.resolve(sourcePath);
  const resolvedTargetPath = path.resolve(targetPath);

  if (!isDirectory(sourcePath)) {
    throw new Error(
      `Cannot sync skills because ${sourcePath} does not exist. Run kana skills install first.`,
    );
  }

  if (isSameOrChildPath(resolvedTargetPath, resolvedSourcePath)) {
    throw new Error("Cannot sync skills into the source skills repository.");
  }

  const sourceSkills = listSourceSkillDirectories(sourcePath, repositoryName);

  if (sourceSkills.length === 0) {
    throw new Error(
      `Cannot sync skills because ${sourcePath} does not contain any Skill directories.`,
    );
  }

  mkdirSync(targetPath, { recursive: true });

  const skills = sourceSkills.map((skill) => {
    const targetSkillPath = path.join(targetPath, skill.name);
    const targetExists = existsSync(targetSkillPath);
    let status: SyncKanaSkillStatus;

    if (targetExists && !replaceExisting) {
      status = "exists";
    } else {
      if (targetExists) {
        rmSync(targetSkillPath, { recursive: true, force: true });
      }

      cpSync(skill.sourcePath, targetSkillPath, {
        recursive: true,
      });

      status = targetExists ? "replaced" : "copied";
    }

    return {
      name: skill.name,
      sourcePath: skill.sourcePath,
      status,
      targetPath: targetSkillPath,
    };
  });

  return {
    sourcePath,
    targetName,
    targetPath,
    skills,
  };
}

function readTargetAgent(targetAgent: string | undefined): KanaSkillSyncTarget {
  if (targetAgent === undefined) {
    throw new Error("Missing target agent. Use `kana skills sync codex` or pass --target-dir.");
  }

  if (isKanaSkillSyncTarget(targetAgent)) {
    return targetAgent;
  }

  throw new Error(
    `Unknown skills sync target: ${targetAgent}. Supported targets: ${KANA_SKILL_SYNC_TARGETS.join(", ")}.`,
  );
}

function isKanaSkillSyncTarget(value: string): value is KanaSkillSyncTarget {
  return KANA_SKILL_SYNC_TARGETS.includes(value as KanaSkillSyncTarget);
}

function getPresetTargetPath(target: KanaSkillSyncTarget, env: NodeJS.ProcessEnv): string {
  switch (target) {
    case "codex": {
      const codexHome = env.CODEX_HOME ?? path.join(env.HOME ?? homedir(), ".codex");
      return path.join(codexHome, "skills");
    }
  }
}

function listSourceSkillDirectories(
  sourcePath: string,
  repositoryName: string,
): SourceSkillDirectory[] {
  if (existsSync(path.join(sourcePath, "SKILL.md"))) {
    return [
      {
        name: repositoryName,
        sourcePath,
      },
    ];
  }

  return readdirSync(sourcePath, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
    .map((entry) => ({
      name: entry.name,
      sourcePath: path.join(sourcePath, entry.name),
    }))
    .filter((entry) => isDirectory(entry.sourcePath))
    .filter((entry) => existsSync(path.join(entry.sourcePath, "SKILL.md")))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function isDirectory(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isSameOrChildPath(childPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
