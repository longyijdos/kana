import { type Static, Type } from "@sinclair/typebox";
import type { Tool } from "@/tools";
import {
  assertKanaMemoryContentSize,
  type KanaMemoryScope,
  listKanaDailyMemory,
  loadKanaMemory,
  readKanaDailyMemory,
  saveKanaMemory,
  searchKanaDailyMemory,
} from "./storage";

export type MemoryConsolidationMode = "incremental" | "full";

export type MemoryConsolidationToolOptions = {
  scope: KanaMemoryScope;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type MemoryConsolidationTransaction = {
  readonly content: string;
  edit(oldText: string, newText: string, replaceAll: boolean): number;
  replace(content: string): void;
  commit(): void;
};

const EDIT_PARAMETERS = Type.Object({
  oldText: Type.String({ minLength: 1, description: "Exact existing memory text to replace." }),
  newText: Type.String({ description: "Replacement text." }),
  replaceAll: Type.Optional(Type.Boolean({ default: false })),
});
const REPLACE_PARAMETERS = Type.Object({
  content: Type.String({ description: "Complete replacement memory." }),
});
const DATE_RANGE_PARAMETERS = Type.Object({
  startDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
  endDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
});
const READ_DAILY_PARAMETERS = Type.Object({
  date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
});
const SEARCH_PARAMETERS = Type.Intersect([
  DATE_RANGE_PARAMETERS,
  Type.Object({ query: Type.String({ minLength: 1 }) }),
]);

export function createMemoryConsolidationTransaction(
  options: MemoryConsolidationToolOptions,
): MemoryConsolidationTransaction {
  let content = loadKanaMemory(options.scope, options);
  let changed = false;

  return {
    get content() {
      return content;
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
    commit() {
      if (changed) {
        saveKanaMemory(options.scope, content, options);
      }
    },
  };
}

export function createMemoryConsolidationTools(
  options: MemoryConsolidationToolOptions,
  mode: MemoryConsolidationMode,
  memory: MemoryConsolidationTransaction,
): Tool[] {
  const readMemoryTool: Tool = {
    name: "read_memory",
    description: "Read the current memory working copy, including this run's pending edits.",
    parameters: Type.Object({}),
    execute: () => result(memory.content),
  };
  const writeTools: Tool[] = [
    {
      name: "edit_memory",
      description:
        "Apply a small exact-text edit to the current memory working copy. Changes are pending until this run completes successfully.",
      parameters: EDIT_PARAMETERS,
      execute: (rawArgs) => {
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
        const args = rawArgs as Static<typeof REPLACE_PARAMETERS>;
        memory.replace(args.content);
        return { content: `Replaced ${options.scope} memory.`, result: { updated: true } };
      },
    },
  ];

  if (mode === "incremental") {
    return [readMemoryTool, ...writeTools];
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
