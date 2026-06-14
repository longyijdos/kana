import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { getKanaConfigPaths } from "./config";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export type KanaSkill = {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
};

export type KanaSkillDiagnostic =
  | {
      type: "warning";
      code: "read_failed" | "parse_failed" | "invalid_metadata";
      message: string;
      path: string;
    }
  | {
      type: "collision";
      code: "name_collision";
      message: string;
      path: string;
      winnerPath: string;
    };

export type LoadKanaSkillsOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  includeDefaults?: boolean;
  skillPaths?: string[];
};

export type LoadKanaSkillsResult = {
  skills: KanaSkill[];
  diagnostics: KanaSkillDiagnostic[];
};

export type KanaSkillActivation = KanaSkill & {
  scope: "project" | "global";
  enabled: boolean;
  mutable: boolean;
};

export type LoadKanaSkillActivationsResult = {
  skills: KanaSkillActivation[];
  diagnostics: KanaSkillDiagnostic[];
};

type SkillFrontmatter = {
  name?: string;
  description?: string;
};

export type FormatKanaSkillsForPromptOptions = {
  env?: NodeJS.ProcessEnv;
};

export function loadKanaSkills(
  options: LoadKanaSkillsOptions = {},
): LoadKanaSkillsResult {
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

export function saveEnabledGlobalSkillNames(
  names: Iterable<string>,
  options: Pick<LoadKanaSkillsOptions, "env"> = {},
): void {
  const { home } = getKanaConfigPaths(options.env);
  const globalSkillsDir = path.join(home, "skills");
  const configPath = path.join(globalSkillsDir, "skills.toml");

  mkdirSync(globalSkillsDir, { recursive: true });
  writeFileSync(configPath, serializeSkillsConfig([...names]), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function formatKanaSkillsForPrompt(
  skills: KanaSkill[],
  options: FormatKanaSkillsForPromptOptions = {},
): string {
  const visibleSkills = selectSkillsForPrompt(skills, options);

  if (visibleSkills.length === 0) {
    return "";
  }

  return [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory, which is the parent directory of SKILL.md.",
    "",
    "<available_skills>",
    ...visibleSkills.flatMap((skill) => [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.filePath)}</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}

function defaultSkillPaths(
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
): string[] {
  const { home } = getKanaConfigPaths(env);

  return [
    path.join(cwd, ".kana", "skills"),
    path.join(cwd, ".agents", "skills"),
    path.join(home, "skills"),
  ];
}

function selectSkillsForPrompt(
  skills: KanaSkill[],
  options: FormatKanaSkillsForPromptOptions,
): KanaSkill[] {
  const { home } = getKanaConfigPaths(options.env);
  const globalSkillsDir = path.join(home, "skills");
  const enabledGlobalSkills = loadEnabledGlobalSkillNames(globalSkillsDir);

  return skills.filter((skill) => {
    if (!isPathInside(skill.filePath, globalSkillsDir)) {
      return true;
    }

    return enabledGlobalSkills.has(skill.name);
  });
}

function loadEnabledGlobalSkillNames(globalSkillsDir: string): Set<string> {
  const configPath = path.join(globalSkillsDir, "skills.toml");

  if (!existsSync(configPath)) {
    return new Set();
  }

  const parsed = Bun.TOML.parse(readFileSync(configPath, "utf8")) as unknown;
  const raw = asRecord(parsed, "skills config");
  const modelInvocation =
    raw.model_invocation === undefined
      ? {}
      : asRecord(raw.model_invocation, "model_invocation");
  const enabled = modelInvocation.enabled;

  if (enabled === undefined) {
    return new Set();
  }

  if (!Array.isArray(enabled)) {
    throw new Error(
      "Invalid skills.toml: model_invocation.enabled must be an array",
    );
  }

  return new Set(
    enabled.map((value, index) => {
      if (typeof value !== "string") {
        throw new Error(
          `Invalid skills.toml: model_invocation.enabled[${index}] must be a string`,
        );
      }

      return value;
    }),
  );
}

function serializeSkillsConfig(enabledNames: string[]): string {
  const enabled = enabledNames.map((name) => JSON.stringify(name)).join(", ");

  return ["[model_invocation]", `enabled = [${enabled}]`, ""].join("\n");
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

function loadSkillsFromDir(
  dir: string,
  visitedDirs: Set<string>,
): LoadKanaSkillsResult {
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

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
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

function loadSkillFromFile(filePath: string): LoadKanaSkillsResult {
  let content: string;

  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    return {
      skills: [],
      diagnostics: [
        {
          type: "warning",
          code: "read_failed",
          message: formatError(error),
          path: filePath,
        },
      ],
    };
  }

  const parsed = parseFrontmatter(content);

  if (!parsed.ok) {
    return {
      skills: [],
      diagnostics: [
        {
          type: "warning",
          code: "parse_failed",
          message: parsed.error,
          path: filePath,
        },
      ],
    };
  }

  const diagnostics: KanaSkillDiagnostic[] = [];
  const frontmatter = parsed.frontmatter;
  const description =
    typeof frontmatter.description === "string"
      ? frontmatter.description
      : undefined;

  for (const error of validateDescription(description)) {
    diagnostics.push({
      type: "warning",
      code: "invalid_metadata",
      message: error,
      path: filePath,
    });
  }

  const baseDir = path.dirname(filePath);
  const fallbackName =
    path.basename(filePath) === "SKILL.md"
      ? path.basename(baseDir)
      : path.basename(filePath, path.extname(filePath));
  const name =
    typeof frontmatter.name === "string" ? frontmatter.name : fallbackName;

  for (const error of validateName(name)) {
    diagnostics.push({
      type: "warning",
      code: "invalid_metadata",
      message: error,
      path: filePath,
    });
  }

  if (!description || description.trim() === "") {
    return {
      skills: [],
      diagnostics,
    };
  }

  return {
    skills: [
      {
        name,
        description,
        filePath,
        baseDir,
      },
    ],
    diagnostics,
  };
}

function parseFrontmatter(content: string):
  | { ok: true; frontmatter: SkillFrontmatter }
  | { ok: false; error: string } {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (!normalized.startsWith("---\n")) {
    return {
      ok: true,
      frontmatter: {},
    };
  }

  const endIndex = normalized.indexOf("\n---", 4);

  if (endIndex === -1) {
    return {
      ok: false,
      error: "frontmatter is missing a closing --- marker",
    };
  }

  return parseMetadataBlock(normalized.slice(4, endIndex));
}

function parseMetadataBlock(content: string):
  | { ok: true; frontmatter: SkillFrontmatter }
  | { ok: false; error: string } {
  const frontmatter: SkillFrontmatter = {};
  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);

    if (!match) {
      return {
        ok: false,
        error: `invalid frontmatter line: ${line}`,
      };
    }

    const key = match[1];
    const rawValue = match[2] ?? "";

    if (rawValue === "|" || rawValue === ">") {
      const blockLines: string[] = [];

      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1] ?? "")) {
        index += 1;
        blockLines.push((lines[index] ?? "").replace(/^ {2}/, ""));
      }

      setFrontmatterValue(frontmatter, key, blockLines.join("\n"));
      continue;
    }

    setFrontmatterValue(frontmatter, key, parseScalar(rawValue.trim()));
  }

  return {
    ok: true,
    frontmatter,
  };
}

function setFrontmatterValue(
  frontmatter: SkillFrontmatter,
  key: string,
  value: string | boolean,
): void {
  switch (key) {
    case "name":
    case "description":
      if (typeof value === "string") {
        frontmatter[key] = value;
      }
      break;
  }
}

function parseScalar(value: string): string | boolean {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);

  return quoted ? quoted[1] ?? "" : value;
}

function validateName(name: string): string[] {
  const errors: string[] = [];

  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }

  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push("name contains invalid characters");
  }

  if (name.startsWith("-") || name.endsWith("-")) {
    errors.push("name must not start or end with a hyphen");
  }

  if (name.includes("--")) {
    errors.push("name must not contain consecutive hyphens");
  }

  return errors;
}

function validateDescription(description: string | undefined): string[] {
  if (!description || description.trim() === "") {
    return ["description is required"];
  }

  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return [
      `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`,
    ];
  }

  return [];
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

function canonicalizePath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isPathInside(candidatePath: string, dir: string): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(candidatePath));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid skills.toml: ${label} must be a table`);
  }

  return value as Record<string, unknown>;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
