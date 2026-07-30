import type { Static, TSchema } from "typebox";

export type ToolExecutionPolicy = {
  deadlineMs?: number;
};

export type ToolSpec<T extends TSchema = TSchema> = {
  name: string;
  description: string;
  // TypeBox schemas are JSON Schema objects, so provider adapters can pass them
  // through as function parameters without a schema conversion step.
  parameters: T;
  execution?: ToolExecutionPolicy;
};

export type ToolContext = {
  toolCallId: string;
  signal?: AbortSignal;
  update(partialResult: unknown): void;
};

export type ToolResult<TResult = unknown> = {
  // Text sent back to the model as the provider-facing tool result.
  content: string;
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
