import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { getKanaConfigPaths } from "../config";
import { formatError } from "../format";
import { loadEnabledGlobalSkillNames } from "./config";
import { loadSkillFromFile } from "./frontmatter";
import { canonicalizePath, isPathInside } from "./paths";
import type {
  KanaSkill,
  KanaSkillDiagnostic,
  LoadKanaSkillActivationsResult,
  LoadKanaSkillsOptions,
  LoadKanaSkillsResult,
} from "./types";

export function loadKanaSkills(options: LoadKanaSkillsOptions = {}): LoadKanaSkillsResult {
  const cwd = options.cwd ?? process.cwd();
  const includeDefaults = options.includeDefaults ?? true;
  const configuredPaths = options.skillPaths ?? [];
  const skillMap = new Map<string, KanaSkill>();
  const realPathSet = new Set<string>();
  const diagnostics: KanaSkillDiagnostic[] = [];

  const paths = [
    ...(includeDefaults ? defaultSkillPaths(cwd, options.env) : []),
    ...configuredPaths.map((skillPath) => path.resolve(cwd, skillPath)),
  ];

  for (const skillPath of paths) {
    const result = loadSkillsFromPath(skillPath);
    diagnostics.push(...result.diagnostics);

    for (const skill of result.skills) {
      const realPath = canonicalizePath(skill.filePath);

      if (realPathSet.has(realPath)) {
        continue;
      }

      const existing = skillMap.get(skill.name);
      if (existing) {
        diagnostics.push({
          type: "collision",
          code: "name_collision",
          message: `skill name "${skill.name}" already loaded`,
          path: skill.filePath,
          winnerPath: existing.filePath,
        });
        continue;
      }

      skillMap.set(skill.name, skill);
      realPathSet.add(realPath);
    }
  }

  return {
    skills: [...skillMap.values()],
    diagnostics,
  };
}

export function loadKanaSkillsFromDir(dir: string): LoadKanaSkillsResult {
  return loadSkillsFromDir(dir, new Set<string>());
}

export function loadKanaSkillActivations(
  options: LoadKanaSkillsOptions = {},
): LoadKanaSkillActivationsResult {
  const { skills, diagnostics } = loadKanaSkills(options);
  const { home } = getKanaConfigPaths(options.env);
  const globalSkillsDir = path.join(home, "skills");
  const enabledGlobalSkills = loadEnabledGlobalSkillNames(globalSkillsDir);

  return {
    skills: skills.map((skill) => {
      const global = isPathInside(skill.filePath, globalSkillsDir);

      return {
        ...skill,
        scope: global ? "global" : "project",
        enabled: global ? enabledGlobalSkills.has(skill.name) : true,
        mutable: global,
      };
    }),
    diagnostics,
  };
}

function defaultSkillPaths(cwd: string, env: NodeJS.ProcessEnv | undefined): string[] {
  const { home } = getKanaConfigPaths(env);

  return [
    path.join(cwd, ".kana", "skills"),
    path.join(cwd, ".agents", "skills"),
    path.join(home, "skills"),
  ];
}

function loadSkillsFromPath(skillPath: string): LoadKanaSkillsResult {
  if (!existsSync(skillPath)) {
    return {
      skills: [],
      diagnostics: [],
    };
  }

  try {
    const stats = statSync(skillPath);

    if (stats.isDirectory()) {
      return loadSkillsFromDir(skillPath, new Set<string>());
    }

    if (stats.isFile() && path.basename(skillPath) === "SKILL.md") {
      return loadSkillFromFile(skillPath);
    }
  } catch (error) {
    return {
      skills: [],
      diagnostics: [
        {
          type: "warning",
          code: "read_failed",
          message: formatError(error),
          path: skillPath,
        },
      ],
    };
  }

  return {
    skills: [],
    diagnostics: [
      {
        type: "warning",
        code: "read_failed",
        message: "skill path is not a directory or SKILL.md file",
        path: skillPath,
      },
    ],
  };
}

function loadSkillsFromDir(dir: string, visitedDirs: Set<string>): LoadKanaSkillsResult {
  const realDir = canonicalizePath(dir);

  if (visitedDirs.has(realDir)) {
    return {
      skills: [],
      diagnostics: [],
    };
  }

  visitedDirs.add(realDir);

  let entries: Array<Dirent<string>>;

  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return {
      skills: [],
      diagnostics: [
        {
          type: "warning",
          code: "read_failed",
          message: formatError(error),
          path: dir,
        },
      ],
    };
  }

  for (const entry of entries) {
    if (entry.name !== "SKILL.md") {
      continue;
    }

    const fullPath = path.join(dir, entry.name);

    if (!isFile(fullPath, entry)) {
      continue;
    }

    return loadSkillFromFile(fullPath);
  }

  const skills: KanaSkill[] = [];
  const diagnostics: KanaSkillDiagnostic[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }

    const fullPath = path.join(dir, entry.name);

    if (isDirectory(fullPath, entry)) {
      const result = loadSkillsFromDir(fullPath, visitedDirs);
      skills.push(...result.skills);
      diagnostics.push(...result.diagnostics);
    }
  }

  return {
    skills,
    diagnostics,
  };
}

function isFile(filePath: string, entry: Dirent<string>): boolean {
  if (entry.isFile()) {
    return true;
  }

  if (!entry.isSymbolicLink()) {
    return false;
  }

  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(filePath: string, entry: Dirent<string>): boolean {
  if (entry.isDirectory()) {
    return true;
  }

  if (!entry.isSymbolicLink()) {
    return false;
  }

  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}
