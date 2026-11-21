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
import { type Static, Type } from "typebox";

import { parseWithSchema, writeFileAtomic } from "@/utils";
import { loadKanaConfig } from "../config";
import { encodeKanaWorkspacePath, getKanaConfigPaths } from "../path";

export const KANA_MEMORY_SCOPES = ["global", "project"] as const;
const CHECKPOINT_HEADER = "<!-- kana-memory-checkpoint: ";
const CHECKPOINT_SUFFIX = " -->";
const DAILY_EXTENSION = ".jsonl";
const DAILY_ENTRY_SCHEMA = Type.Object({
  id: Type.String({ minLength: 1 }),
  createdAt: Type.String({ minLength: 1 }),
  scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
  title: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  content: Type.String({ minLength: 1 }),
});
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

export type KanaMemoryEntry = Readonly<Static<typeof DAILY_ENTRY_SCHEMA>>;

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
      dailyPath: path.join(
        memoryDirectory,
        "daily",
        `${formatMemoryDate(options.now)}${DAILY_EXTENSION}`,
      ),
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
    dailyPath: path.join(dailyDirectory, `${formatMemoryDate(options.now)}${DAILY_EXTENSION}`),
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
  appendFileSync(dailyPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });

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

  const end = raw.indexOf("\n");
  const line = raw.slice(0, end).replace(/\r$/, "");
  if (end < 0 || !line.endsWith(CHECKPOINT_SUFFIX)) {
    throw new Error("Invalid memory checkpoint header.");
  }
  const checkpoint = parseWithSchema(
    CHECKPOINT_SCHEMA,
    JSON.parse(line.slice(CHECKPOINT_HEADER.length, -CHECKPOINT_SUFFIX.length)),
    "memory checkpoint",
  );
  return { content: raw.slice(end + 1).replace(/^\r?\n/, ""), checkpoint };
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
    ? `${CHECKPOINT_HEADER}${JSON.stringify(checkpoint)}${CHECKPOINT_SUFFIX}\n\n`
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
  const dailyPath = path.join(dailyDirectory, `${date}${DAILY_EXTENSION}`);

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
    unlinkSync(path.join(dailyDirectory, `${date}${DAILY_EXTENSION}`));
    pruned.push(date);
  }
  return pruned;
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
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
    .map((entry) => entry.name.slice(0, -DAILY_EXTENSION.length))
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
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => {
    const label = `daily memory ${date}, line ${index + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Invalid ${label}: expected a JSON record.`);
    }
    const entry = parseWithSchema(DAILY_ENTRY_SCHEMA, value, label);
    if (entry.scope !== scope) throw new Error(`Invalid ${label}: wrong scope.`);
    return entry;
  });
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

function countCharacters(value: string): number {
  return [...value].length;
}
