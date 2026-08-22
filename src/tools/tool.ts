import type { Static, TSchema } from "typebox";

import type { ToolSpec, UserImage } from "@/core";

export type ToolContext = {
  toolCallId: string;
  signal?: AbortSignal;
  update(partialResult: unknown): void;
};

export type ToolResult<TResult = unknown> = {
  // Text sent back to the model as the provider-facing tool result.
  content: string;
  // Visual observations remain provider-neutral until a model adapter encodes
  // them in the wire shape supported by its protocol.
  images?: UserImage[];
  // Structured result remains available for agent consumers and logs.
  result: TResult;
  isError?: boolean;
};

export type Tool<T extends TSchema = TSchema, TResult = unknown> = ToolSpec<T> & {
  execute(
    args: Static<T>,
    context: ToolContext,
  ): Promise<ToolResult<TResult> | TResult> | ToolResult<TResult> | TResult;
};
