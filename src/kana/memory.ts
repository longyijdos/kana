import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { getKanaConfigPaths, loadKanaConfig } from "./config";
import { encodeKanaWorkspacePath } from "./workspace-path";

export const KANA_MEMORY_SCOPES = ["global", "project"] as const;

export type KanaMemoryScope = (typeof KANA_MEMORY_SCOPES)[number];

export type KanaMemoryPaths = {
  memoryPath: string;
  dailyPath: string;
  dailyDirectory: string;
};

export type KanaMemoryEntry = {
  id: string;
  createdAt: string;
  scope: KanaMemoryScope;
  title?: string;
  reason?: string;
  content: string;
};

export type AppendKanaMemoryOptions = {
  scope?: KanaMemoryScope;
  content: string;
  title?: string;
  reason?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  id?: string;
};

export type KanaMemoryPathOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
};

export function getKanaMemoryPaths(
  scope: KanaMemoryScope,
  options: KanaMemoryPathOptions = {},
): KanaMemoryPaths {
  const configPaths = getKanaConfigPaths(options.env);

  if (scope === "global") {
    return {
      memoryPath: configPaths.memoryPath,
      dailyPath: path.join(configPaths.memoryDailyPath, `${formatMemoryDate(options.now)}.md`),
      dailyDirectory: configPaths.memoryDailyPath,
    };
  }

  const projectPath = path.join(
    configPaths.projectsPath,
    encodeKanaWorkspacePath(options.cwd ?? process.cwd()),
  );
  const dailyDirectory = path.join(projectPath, "daily");

  return {
    memoryPath: path.join(projectPath, "memory.md"),
    dailyPath: path.join(dailyDirectory, `${formatMemoryDate(options.now)}.md`),
    dailyDirectory,
  };
}

export function appendKanaMemory(options: AppendKanaMemoryOptions): KanaMemoryEntry {
  const scope = options.scope ?? "project";
  const content = normalizeRequiredText(options.content, "Memory content");
  const entry: KanaMemoryEntry = {
    id: options.id ?? `mem_${randomUUID()}`,
    createdAt: (options.now ?? new Date()).toISOString(),
    scope,
    title: normalizeOptionalText(options.title),
    reason: normalizeOptionalText(options.reason),
    content,
  };
  const { dailyPath, dailyDirectory } = getKanaMemoryPaths(scope, options);

  mkdirSync(dailyDirectory, { recursive: true });
  appendFileSync(dailyPath, formatKanaMemoryEntry(entry), { encoding: "utf8", mode: 0o600 });

  return entry;
}

export function loadKanaMemory(
  scope: KanaMemoryScope,
  options: Omit<KanaMemoryPathOptions, "now"> = {},
): string {
  const { memoryPath } = getKanaMemoryPaths(scope, options);
  return existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "";
}

export function saveKanaMemory(
  scope: KanaMemoryScope,
  content: string,
  options: Omit<KanaMemoryPathOptions, "now"> = {},
): void {
  const { memoryPath } = getKanaMemoryPaths(scope, options);
  const normalized = content.trim();
  const maxChars = loadKanaConfig(options.env).memory.maxChars;
  const characterCount = countCharacters(normalized);

  if (characterCount > maxChars) {
    throw new Error(
      `Memory content exceeds memory.max_chars: ${characterCount} / ${maxChars} characters. Compress it before saving.`,
    );
  }

  mkdirSync(path.dirname(memoryPath), { recursive: true });
  const temporaryPath = `${memoryPath}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, normalized ? `${normalized}\n` : "", {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, memoryPath);
}

function formatKanaMemoryEntry(entry: KanaMemoryEntry): string {
  const fields = [
    `id: ${quoteYaml(entry.id)}`,
    `created_at: ${quoteYaml(entry.createdAt)}`,
    `scope: ${quoteYaml(entry.scope)}`,
    entry.title ? `title: ${quoteYaml(entry.title)}` : undefined,
    entry.reason ? `reason: ${quoteYaml(entry.reason)}` : undefined,
  ].filter((field): field is string => field !== undefined);

  return `---\n${fields.join("\n")}\n---\n\n${entry.content}\n\n`;
}

function formatMemoryDate(now = new Date()): string {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

function normalizeRequiredText(value: string, label: string): string {
  const normalized = value.trim();

  if (!normalized) {
    throw new Error(`${label} must not be empty.`);
  }

  return normalized;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function countCharacters(value: string): number {
  return [...value].length;
}
