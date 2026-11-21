import { type Static, Type } from "typebox";
import type { Tool } from "@/tools";
import { strictObject } from "@/tools";
import {
  assertKanaMemoryContentSize,
  type KanaMemoryCheckpoint,
  type KanaMemoryEntry,
  type KanaMemoryScope,
  listKanaDailyMemory,
  loadKanaMemory,
  readKanaDailyMemory,
  saveKanaMemory,
  searchKanaDailyMemory,
  writeKanaMemoryState,
} from "./storage";

export type MemoryConsolidationMode = "incremental" | "full";

export type MemoryConsolidationToolOptions = {
  scope: KanaMemoryScope;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxChars?: number;
};

export type MemoryConsolidationTransaction = {
  readonly content: string;
  readonly hasChanges: boolean;
  edit(oldText: string, newText: string, replaceAll: boolean): number;
  replace(content: string): void;
  commit(checkpoint?: KanaMemoryCheckpoint): void;
};

type MemoryBatchReview = {
  readonly confirmed: boolean;
  readonly tool: Tool;
};

const CONFIRM_PARAMETERS = strictObject({
  reviews: Type.Array(
    strictObject({
      id: Type.String({ minLength: 1 }),
      disposition: Type.Union([
        Type.Literal("retained"),
        Type.Literal("already_covered"),
        Type.Literal("omitted"),
      ]),
    }),
    { minItems: 1 },
  ),
});

export function createMemoryBatchReview(entries: readonly KanaMemoryEntry[]): MemoryBatchReview {
  const expected = new Set(entries.map((entry) => entry.id));
  let confirmed = false;
  return {
    get confirmed() {
      return confirmed;
    },
    tool: {
      name: "confirm_memory_batch",
      description:
        "After finalizing memory, confirm exactly one disposition per supplied entry ID. Use omitted only when an entry should not be kept.",
      parameters: CONFIRM_PARAMETERS,
      execute(rawArgs) {
        const { reviews } = rawArgs as Static<typeof CONFIRM_PARAMETERS>;
        const reviewed = new Set(reviews.map(({ id }) => id));
        confirmed =
          reviews.length === expected.size &&
          reviewed.size === expected.size &&
          [...reviewed].every((id) => expected.has(id));
        if (!confirmed) throw new Error("Confirm every supplied entry ID exactly once.");
        return result({ confirmed: true });
      },
    },
  };
}

const EDIT_PARAMETERS = strictObject({
  oldText: Type.String({ minLength: 1, description: "Exact existing memory text to replace." }),
  newText: Type.String({ description: "Replacement text." }),
  replaceAll: Type.Optional(Type.Boolean({ default: false })),
});
const REPLACE_PARAMETERS = strictObject({
  content: Type.String({ description: "Complete replacement memory." }),
});
const DATE_RANGE_PROPERTIES = {
  startDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
  endDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
};
const DATE_RANGE_PARAMETERS = strictObject(DATE_RANGE_PROPERTIES);
const READ_DAILY_PARAMETERS = strictObject({
  date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
});
const SEARCH_PARAMETERS = strictObject({
  ...DATE_RANGE_PROPERTIES,
  query: Type.String({ minLength: 1 }),
});

export function createMemoryConsolidationTransaction(
  options: MemoryConsolidationToolOptions,
): MemoryConsolidationTransaction {
  let content = loadKanaMemory(options.scope, options);
  let changed = false;

  return {
    get content() {
      return content;
    },
    get hasChanges() {
      return changed;
    },
    edit(oldText, newText, replaceAll) {
      if (!oldText) {
        throw new Error("oldText must not be empty.");
      }

      const matches = content.split(oldText).length - 1;
      if (matches === 0) {
        throw new Error("oldText was not found in memory.");
      }
      if (!replaceAll && matches > 1) {
        throw new Error(
          `oldText appears ${matches} times in memory; provide more specific text or set replaceAll.`,
        );
      }

      const nextContent = replaceAll
        ? content.split(oldText).join(newText)
        : content.replace(oldText, newText);
      assertKanaMemoryContentSize(nextContent, options);
      changed ||= nextContent !== content;
      content = nextContent;
      return replaceAll ? matches : 1;
    },
    replace(nextContent) {
      assertKanaMemoryContentSize(nextContent, options);
      changed ||= nextContent !== content;
      content = nextContent;
    },
    commit(checkpoint) {
      if (checkpoint === undefined) {
        if (changed) saveKanaMemory(options.scope, content, options);
      } else {
        const normalized = changed ? content.trim() : undefined;
        const body = normalized === undefined ? content : normalized ? `${normalized}\n` : "";
        writeKanaMemoryState(options.scope, body, checkpoint, options);
      }
    },
  };
}

export function createMemoryConsolidationTools(
  options: MemoryConsolidationToolOptions,
  mode: MemoryConsolidationMode,
  memory: MemoryConsolidationTransaction,
  review?: MemoryBatchReview,
): Tool[] {
  const readMemoryTool: Tool = {
    name: "read_memory",
    description: "Read the current memory working copy, including this run's pending edits.",
    parameters: strictObject({}),
    execute: () => result(memory.content),
  };
  const writeTools: Tool[] = [
    {
      name: "edit_memory",
      description:
        "Apply a small exact-text edit to the current memory working copy. Changes are pending until this run completes successfully.",
      parameters: EDIT_PARAMETERS,
      execute: (rawArgs) => {
        if (review?.confirmed) throw new Error("Memory edits must precede batch confirmation.");
        const args = rawArgs as Static<typeof EDIT_PARAMETERS>;
        const replacements = memory.edit(args.oldText, args.newText, args.replaceAll ?? false);
        return { content: `Updated ${options.scope} memory.`, result: { replacements } };
      },
    },
    {
      name: "replace_memory",
      description:
        "Replace the current memory working copy. Changes are pending until this run completes successfully.",
      parameters: REPLACE_PARAMETERS,
      execute: (rawArgs) => {
        if (review?.confirmed) throw new Error("Memory edits must precede batch confirmation.");
        const args = rawArgs as Static<typeof REPLACE_PARAMETERS>;
        memory.replace(args.content);
        return { content: `Replaced ${options.scope} memory.`, result: { updated: true } };
      },
    },
  ];

  if (mode === "incremental") {
    return [readMemoryTool, ...writeTools, ...(review ? [review.tool] : [])];
  }

  return [
    readMemoryTool,
    {
      name: "list_daily_memory",
      description: "List available daily-memory dates for this consolidation run.",
      parameters: DATE_RANGE_PARAMETERS,
      execute: (rawArgs) => {
        const args = rawArgs as Static<typeof DATE_RANGE_PARAMETERS>;
        return result(listKanaDailyMemory(options.scope, { ...options, ...args }));
      },
    },
    {
      name: "read_daily_memory",
      description: "Read all daily-memory entries for one date.",
      parameters: READ_DAILY_PARAMETERS,
      execute: (rawArgs) => {
        const args = rawArgs as Static<typeof READ_DAILY_PARAMETERS>;
        return result(readKanaDailyMemory(options.scope, args.date, options));
      },
    },
    {
      name: "search_daily_memory",
      description: "Search the available daily-memory entries.",
      parameters: SEARCH_PARAMETERS,
      execute: (rawArgs) => {
        const args = rawArgs as Static<typeof SEARCH_PARAMETERS>;
        return result(searchKanaDailyMemory(options.scope, args.query, { ...options, ...args }));
      },
    },
    ...writeTools,
  ];
}

function result(value: unknown): { content: string; result: unknown } {
  return { content: JSON.stringify(value), result: value };
}
