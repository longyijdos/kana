import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { getKanaConfigPaths, loadKanaConfig } from "../config";
import { encodeKanaWorkspacePath } from "../workspace-path";
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

export type KanaDailyMemoryDay = {
  date: string;
  entryCount: number;
};

export type KanaDailyMemorySearchDay = KanaDailyMemoryDay & {
  matchCount: number;
  snippets: string[];
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

export type KanaDailyMemoryRangeOptions = Omit<KanaMemoryPathOptions, "now"> & {
  startDate?: string;
  endDate?: string;
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
  const normalized = assertKanaMemoryContentSize(content, options);

  mkdirSync(path.dirname(memoryPath), { recursive: true });
  const temporaryPath = `${memoryPath}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, normalized ? `${normalized}\n` : "", {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, memoryPath);
}

export function assertKanaMemoryContentSize(
  content: string,
  options: Omit<KanaMemoryPathOptions, "now"> = {},
): string {
  const normalized = content.trim();
  const maxChars = loadKanaConfig(options.env).memory.maxChars;
  const characterCount = countCharacters(normalized);

  if (characterCount > maxChars) {
    throw new Error(
      `Memory content exceeds memory.max_chars: ${characterCount} / ${maxChars} characters. Compress it before saving.`,
    );
  }

  return normalized;
}

export function listKanaDailyMemory(
  scope: KanaMemoryScope,
  options: KanaDailyMemoryRangeOptions = {},
): KanaDailyMemoryDay[] {
  const dates = listDailyMemoryDates(scope, options);

  return dates.map((date) => ({
    date,
    entryCount: readKanaDailyMemory(scope, date, options).length,
  }));
}

export function readKanaDailyMemory(
  scope: KanaMemoryScope,
  date: string,
  options: Omit<KanaMemoryPathOptions, "now"> = {},
): KanaMemoryEntry[] {
  assertMemoryDate(date, "date");
  const { dailyDirectory } = getKanaMemoryPaths(scope, options);
  const dailyPath = path.join(dailyDirectory, `${date}.md`);

  if (!existsSync(dailyPath)) {
    throw new Error(`Daily memory not found for ${date}.`);
  }

  return parseKanaDailyMemory(readFileSync(dailyPath, "utf8"), date, scope);
}

export function searchKanaDailyMemory(
  scope: KanaMemoryScope,
  query: string,
  options: KanaDailyMemoryRangeOptions = {},
): KanaDailyMemorySearchDay[] {
  const normalizedQuery = normalizeRequiredText(query, "Memory search query").toLowerCase();

  return listDailyMemoryDates(scope, options).flatMap((date) => {
    const entries = readKanaDailyMemory(scope, date, options);
    const matches = entries.filter((entry) =>
      [entry.title, entry.reason, entry.content]
        .filter((value): value is string => value !== undefined)
        .some((value) => value.toLowerCase().includes(normalizedQuery)),
    );

    return matches.length > 0
      ? [
          {
            date,
            entryCount: entries.length,
            matchCount: matches.length,
            snippets: matches.slice(0, 3).map(formatMemorySearchSnippet),
          },
        ]
      : [];
  });
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

function listDailyMemoryDates(
  scope: KanaMemoryScope,
  options: KanaDailyMemoryRangeOptions,
): string[] {
  if (options.startDate) {
    assertMemoryDate(options.startDate, "startDate");
  }
  if (options.endDate) {
    assertMemoryDate(options.endDate, "endDate");
  }
  if (options.startDate && options.endDate && options.startDate > options.endDate) {
    throw new Error("startDate must not be after endDate.");
  }

  const { dailyDirectory } = getKanaMemoryPaths(scope, options);
  if (!existsSync(dailyDirectory)) {
    return [];
  }

  return readdirSync(dailyDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
    .map((entry) => entry.name.slice(0, -".md".length))
    .filter(
      (date) =>
        (!options.startDate || date >= options.startDate) &&
        (!options.endDate || date <= options.endDate),
    )
    .sort();
}

function parseKanaDailyMemory(
  content: string,
  date: string,
  scope: KanaMemoryScope,
): KanaMemoryEntry[] {
  const entries: KanaMemoryEntry[] = [];
  const expression = /^---\n([\s\S]*?)\n---\n\n([\s\S]*?)(?=\n\n---\nid:|$)/gm;
  for (let match = expression.exec(content); match !== null; match = expression.exec(content)) {
    const fields = Object.fromEntries(
      match[1].split("\n").map((line) => {
        const separator = line.indexOf(": ");
        return [line.slice(0, separator), JSON.parse(line.slice(separator + 2)) as unknown];
      }),
    );
    const entryScope = fields.scope;

    if (entryScope !== scope) {
      throw new Error(`Daily memory ${date} contains an entry with the wrong scope.`);
    }
    if (typeof fields.id !== "string" || typeof fields.created_at !== "string") {
      throw new Error(`Daily memory ${date} has invalid entry metadata.`);
    }

    entries.push({
      id: fields.id,
      createdAt: fields.created_at,
      scope,
      title: typeof fields.title === "string" ? fields.title : undefined,
      reason: typeof fields.reason === "string" ? fields.reason : undefined,
      content: normalizeRequiredText(match[2], `Daily memory ${date} entry content`),
    });
  }

  if (entries.length === 0 && content.trim()) {
    throw new Error(`Daily memory ${date} is malformed.`);
  }

  return entries;
}

function formatMemorySearchSnippet(entry: KanaMemoryEntry): string {
  const text = entry.title ?? entry.content.replace(/\s+/g, " ");
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function formatMemoryDate(now = new Date()): string {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

function assertMemoryDate(value: string, name: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`${name} must be a valid YYYY-MM-DD date.`);
  }

  const [year, month, day] = match.slice(1).map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${name} must be a valid YYYY-MM-DD date.`);
  }
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
