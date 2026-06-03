import type { Static, TSchema } from "@sinclair/typebox";

export type ToolSpec<T extends TSchema = TSchema> = {
  name: string;
  description: string;
  // TypeBox schemas are JSON Schema objects, so provider adapters can pass them
  // through as function parameters without a schema conversion step.
  parameters: T;
};

export type Tool<T extends TSchema = TSchema, TResult = unknown> =
  ToolSpec<T> & {
    execute(args: Static<T>): Promise<TResult> | TResult;
  };
