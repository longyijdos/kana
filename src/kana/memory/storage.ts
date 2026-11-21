import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { Type } from "typebox";

import { parseWithSchema, writeFileAtomic } from "@/utils";
import { loadKanaConfig } from "../config";
import { encodeKanaWorkspacePath, getKanaConfigPaths } from "../path";

export const KANA_MEMORY_SCOPES = ["global", "project"] as const;
const CHECKPOINT_HEADER = "<!-- kana-memory-checkpoint: ";
const CHECKPOINT_SUFFIX = " -->\n";
const CHECKPOINT_SCHEMA = Type.Tuple([
  Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  Type.String({ minLength: 1 }),
]);
const MAX_BATCH_ENTRIES = 32;
const MAX_BATCH_CHARS = 16_000;

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

export type KanaMemoryCheckpoint = readonly [date: string, lastId: string];

export type PendingKanaMemoryBatch = {
  readonly entries: readonly KanaMemoryEntry[];
  readonly checkpoint: KanaMemoryCheckpoint;
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

export type KanaMemoryWriteOptions = Omit<KanaMemoryPathOptions, "now"> & {
  maxChars?: number;
};

export type KanaDailyMemoryRangeOptions = Omit<KanaMemoryPathOptions, "now"> & {
  startDate?: string;
  endDate?: string;
};

export type PruneKanaDailyMemoryOptions = KanaMemoryPathOptions & {
  retentionDays: number;
};

export function getKanaMemoryPaths(
  scope: KanaMemoryScope,
  options: KanaMemoryPathOptions = {},
): KanaMemoryPaths {
  const configPaths = getKanaConfigPaths(options.env);

  if (scope === "global") {
    const memoryDirectory = path.join(configPaths.memoryDirectory, "global");
    return {
      memoryPath: path.join(memoryDirectory, "memory.md"),
      dailyPath: path.join(memoryDirectory, "daily", `${formatMemoryDate(options.now)}.md`),
      dailyDirectory: path.join(memoryDirectory, "daily"),
    };
  }

  const projectPath = path.join(
    configPaths.memoryDirectory,
    "projects",
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
  return loadKanaMemoryState(scope, options).content;
}

function loadKanaMemoryState(
  scope: KanaMemoryScope,
  options: KanaMemoryPathOptions,
): { content: string; checkpoint?: KanaMemoryCheckpoint } {
  const { memoryPath } = getKanaMemoryPaths(scope, options);
  const raw = existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "";
  if (!raw.startsWith(CHECKPOINT_HEADER)) {
    return { content: raw };
  }

  const end = raw.indexOf("\n") + 1;
  if (!raw.slice(0, end).endsWith(CHECKPOINT_SUFFIX)) {
    throw new Error("Invalid memory checkpoint header.");
  }
  const checkpoint = parseWithSchema(
    CHECKPOINT_SCHEMA,
    JSON.parse(raw.slice(CHECKPOINT_HEADER.length, end - CHECKPOINT_SUFFIX.length)),
    "memory checkpoint",
  );
  return { content: raw.slice(end).replace(/^\n/, ""), checkpoint };
}

export function saveKanaMemory(
  scope: KanaMemoryScope,
  content: string,
  options: KanaMemoryWriteOptions = {},
): void {
  const normalized = assertKanaMemoryContentSize(content, options);
  const { checkpoint } = loadKanaMemoryState(scope, options);
  writeKanaMemoryState(scope, normalized ? `${normalized}\n` : "", checkpoint, options);
}

export function writeKanaMemoryState(
  scope: KanaMemoryScope,
  content: string,
  checkpoint: KanaMemoryCheckpoint | undefined,
  options: KanaMemoryPathOptions,
): void {
  const { memoryPath } = getKanaMemoryPaths(scope, options);
  const header = checkpoint
    ? `${CHECKPOINT_HEADER}${JSON.stringify(checkpoint)}${CHECKPOINT_SUFFIX}\n`
    : "";
  writeFileAtomic(memoryPath, `${header}${content}`);
}

export function readPendingKanaMemoryBatch(
  scope: KanaMemoryScope,
  options: KanaMemoryPathOptions = {},
): PendingKanaMemoryBatch | undefined {
  const { checkpoint: committed } = loadKanaMemoryState(scope, options);
  const [committedDate, committedId] = committed ?? [];
  const entries: KanaMemoryEntry[] = [];
  let checkpoint: KanaMemoryCheckpoint | undefined;
  let chars = 0;
  for (const date of listDailyMemoryDates(scope, { ...options, startDate: committedDate })) {
    const day = readKanaDailyMemory(scope, date, options);
    const start = date === committedDate ? day.findIndex(({ id }) => id === committedId) + 1 : 0;
    for (const entry of day.slice(start)) {
      const size = JSON.stringify(entry).length;
      if (checkpoint && chars + size > MAX_BATCH_CHARS) return { entries, checkpoint };
      entries.push(entry);
      checkpoint = [date, entry.id];
      chars += size;
      if (entries.length === MAX_BATCH_ENTRIES) return { entries, checkpoint };
    }
  }
  return checkpoint ? { entries, checkpoint } : undefined;
}

export function assertKanaMemoryContentSize(
  content: string,
  options: KanaMemoryWriteOptions = {},
): string {
  const normalized = content.trim();
  const maxChars = options.maxChars ?? loadKanaConfig(options.env).memory.maxChars;
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

/**
 * Removes expired daily-memory files after a successful full consolidation.
 */
export function pruneKanaDailyMemory(
  scope: KanaMemoryScope,
  options: PruneKanaDailyMemoryOptions,
): string[] {
  if (!Number.isInteger(options.retentionDays) || options.retentionDays <= 0) {
    throw new Error("retentionDays must be a positive integer.");
  }

  const now = options.now ?? new Date();
  const earliestRetained = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  earliestRetained.setDate(earliestRetained.getDate() - options.retentionDays + 1);
  const cutoffDate = formatMemoryDate(earliestRetained);
  const { dailyDirectory } = getKanaMemoryPaths(scope, options);
  const { checkpoint } = loadKanaMemoryState(scope, options);
  if (!checkpoint) return [];
  const [committedDate, committedId] = checkpoint;
  const pruned: string[] = [];
  for (const date of listDailyMemoryDates(scope, { ...options, endDate: committedDate })) {
    if (date >= cutoffDate) break;
    if (
      date === committedDate &&
      readKanaDailyMemory(scope, date, options).at(-1)?.id !== committedId
    )
      continue;
    unlinkSync(path.join(dailyDirectory, `${date}.md`));
    pruned.push(date);
  }
  return pruned;
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
  const expression = /---\n([\s\S]*?)\n---\n\n([\s\S]*?)\n\n(?=---\nid:|(?![\s\S]))/y;
  let offset = 0;
  while (offset < content.length) {
    const match = expression.exec(content);
    if (!match) throw new Error(`Daily memory ${date} is malformed.`);
    offset = expression.lastIndex;
    const [, header = "", body = ""] = match;
    const fields = Object.fromEntries(
      header.split("\n").map((line) => {
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
      content: normalizeRequiredText(body, `Daily memory ${date} entry content`),
    });
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

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
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
