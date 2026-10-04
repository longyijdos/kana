import { Type } from "typebox";
import type { Tool } from "@/tools";
import { strictObject } from "@/tools";
import { appendKanaMemory, type KanaMemoryEntry, type KanaMemoryScope } from "../memory/storage";

export const rememberParameters = strictObject({
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

export type RememberToolResult = {
  id: string;
  scope: KanaMemoryScope;
};

export type RememberToolOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onRecorded?: (entry: KanaMemoryEntry) => void;
};

export function createRememberTool(
  options: RememberToolOptions = {},
): Tool<typeof rememberParameters, RememberToolResult> {
  return {
    name: "remember",
    description:
      "Proactively save non-sensitive durable information that will help future conversations, including user preferences, recurring constraints, relevant background, confirmed decisions, meaningful milestones, and unfinished work. Record it even when the current response already handles the request. Default to project scope; use global only for information that applies across projects. Do not save secrets, sensitive personal information, transient progress, or facts available directly from the workspace.",
    parameters: rememberParameters,
    outputSchema: Type.Object({
      id: Type.String(),
      scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
    }),
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
      options.onRecorded?.(entry);
      return {
        content: `Memory recorded in ${entry.scope} scope.`,
        result: { id: entry.id, scope: entry.scope } satisfies RememberToolResult,
      };
    },
  };
}
