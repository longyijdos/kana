import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { getKanaConfigPaths } from "../path";
import { DEFAULT_KANA_SKILLS_REPOSITORY_NAME, isDirectory } from "./install";

const KANA_SKILL_SYNC_TARGETS = ["codex", "claude"] as const;

type KanaSkillSyncTarget = (typeof KANA_SKILL_SYNC_TARGETS)[number];

export type SyncKanaSkillsOptions = {
  repositoryName?: string;
  targetAgent?: string;
  targetDir?: string;
};

export type ResyncKanaSkillsOptions = SyncKanaSkillsOptions;

type SyncKanaSkillStatus = "copied" | "exists" | "replaced";

type SyncKanaSkillResult = {
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
      const isIgnored = createSkillIgnoreMatcher(skill.sourcePath);

      if (targetExists) {
        removeUnignoredFiles(targetSkillPath, isIgnored);
      }

      copyUnignoredFiles(skill.sourcePath, targetSkillPath, isIgnored);

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
    throw new Error(
      "Missing target agent. Use `kana skills sync codex`, `kana skills sync claude`, or pass --target-dir.",
    );
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
    case "claude": {
      const claudeHome = env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? homedir(), ".claude");
      return path.join(claudeHome, "skills");
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

type IgnoreMatcher = (relativeFilePaths: string[]) => Set<string>;

// Uses the source skill's own .gitignore rules, so user data such as drafts or
// .env files survives a resync. A source outside a Git work tree ignores nothing.
function createSkillIgnoreMatcher(skillPath: string): IgnoreMatcher {
  return (relativeFilePaths) => {
    if (relativeFilePaths.length === 0) {
      return new Set();
    }

    // File paths only: check-ignore misreports directory paths with a trailing slash.
    const result = spawnSync("git", ["check-ignore", "--no-index", "--stdin", "-z"], {
      cwd: skillPath,
      encoding: "utf8",
      input: relativeFilePaths.join("\0"),
    });

    if (result.status !== 0) {
      return new Set();
    }

    return new Set(result.stdout.split("\0").filter((entry) => entry !== ""));
  };
}

function listFiles(root: string, directory = ""): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(root, relativePath) : [relativePath];
  });
}

function copyUnignoredFiles(
  sourceRoot: string,
  targetRoot: string,
  isIgnored: IgnoreMatcher,
): void {
  const files = listFiles(sourceRoot);
  const ignored = isIgnored(files);

  mkdirSync(targetRoot, { recursive: true });
  for (const file of files) {
    if (!ignored.has(file)) {
      mkdirSync(path.dirname(path.join(targetRoot, file)), { recursive: true });
      cpSync(path.join(sourceRoot, file), path.join(targetRoot, file));
    }
  }
}

function removeUnignoredFiles(root: string, isIgnored: IgnoreMatcher): void {
  const files = listFiles(root);
  const ignored = isIgnored(files);
  const touchedDirectories = new Set<string>();

  for (const file of files) {
    if (!ignored.has(file)) {
      rmSync(path.join(root, file), { force: true });
      touchedDirectories.add(path.dirname(file));
    }
  }

  // Prune only directories emptied here; empty directories the user made stay.
  const deepestFirst = [...touchedDirectories].sort((left, right) => right.length - left.length);
  for (const directory of deepestFirst) {
    for (let current = directory; current !== "."; current = path.dirname(current)) {
      const absolutePath = path.join(root, current);
      if (!existsSync(absolutePath) || readdirSync(absolutePath).length > 0) {
        break;
      }
      rmSync(absolutePath, { recursive: true });
    }
  }
}

function isSameOrChildPath(childPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
