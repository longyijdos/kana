import { Type } from "@sinclair/typebox";

import { appendKanaMemory, type KanaMemoryEntry } from "@/kana";
import type { Tool } from "./tool";

export const rememberParameters = Type.Object({
  content: Type.String({
    minLength: 1,
    description: "The durable fact, preference, decision, or unfinished work to retain.",
  }),
  scope: Type.Optional(
    Type.Union([Type.Literal("global"), Type.Literal("project")], {
      default: "project",
      description:
        "Use project by default. Use global only for preferences that apply across projects.",
    }),
  ),
  title: Type.Optional(
    Type.String({
      maxLength: 120,
      description: "A short, scannable subject for this memory.",
    }),
  ),
  reason: Type.Optional(
    Type.String({
      maxLength: 500,
      description: "Why this information should be retained across future conversations.",
    }),
  ),
});

export type RememberToolResult = KanaMemoryEntry;

export type RememberToolOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export function createRememberTool(
  options: RememberToolOptions = {},
): Tool<typeof rememberParameters, RememberToolResult> {
  return {
    name: "remember",
    description: "Save durable context for future conversations.",
    parameters: rememberParameters,
    execute: (args, context) => {
      if (context.signal?.aborted) {
        throw new Error("Remember aborted.");
      }

      const entry = appendKanaMemory({
        content: args.content,
        scope: args.scope,
        title: args.title,
        reason: args.reason,
        cwd: options.cwd,
        env: options.env,
      });
      return {
        content: `Memory recorded in ${entry.scope} scope.`,
        result: entry satisfies RememberToolResult,
      };
    },
  };
}
