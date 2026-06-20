import { type Static, Type } from "@sinclair/typebox";
import type { Tool } from "@/tools";
import {
  editKanaMemory,
  type KanaMemoryScope,
  listKanaDailyMemory,
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

export function createMemoryConsolidationTools(
  options: MemoryConsolidationToolOptions,
  mode: MemoryConsolidationMode,
): Tool[] {
  const writeTools: Tool[] = [
    {
      name: "edit_memory",
      description: "Apply a small exact-text edit to consolidated memory in the fixed scope.",
      parameters: EDIT_PARAMETERS,
      execute: (rawArgs) => {
        const args = rawArgs as Static<typeof EDIT_PARAMETERS>;
        const replacements = editKanaMemory(
          options.scope,
          args.oldText,
          args.newText,
          args.replaceAll,
          options,
        );
        return { content: `Updated ${options.scope} memory.`, result: { replacements } };
      },
    },
    {
      name: "replace_memory",
      description: "Replace consolidated memory in the fixed scope.",
      parameters: REPLACE_PARAMETERS,
      execute: (rawArgs) => {
        const args = rawArgs as Static<typeof REPLACE_PARAMETERS>;
        saveKanaMemory(options.scope, args.content, options);
        return { content: `Replaced ${options.scope} memory.`, result: { updated: true } };
      },
    },
  ];

  if (mode === "incremental") {
    return writeTools;
  }

  return [
    {
      name: "list_daily_memory",
      description: "List available daily memory dates in the fixed scope.",
      parameters: DATE_RANGE_PARAMETERS,
      execute: (rawArgs) => {
        const args = rawArgs as Static<typeof DATE_RANGE_PARAMETERS>;
        return result(listKanaDailyMemory(options.scope, { ...options, ...args }));
      },
    },
    {
      name: "read_daily_memory",
      description: "Read all memory entries for one date in the fixed scope.",
      parameters: READ_DAILY_PARAMETERS,
      execute: (rawArgs) => {
        const args = rawArgs as Static<typeof READ_DAILY_PARAMETERS>;
        return result(readKanaDailyMemory(options.scope, args.date, options));
      },
    },
    {
      name: "search_daily_memory",
      description: "Search daily memory text in the fixed scope.",
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
