import type { Static, TSchema } from "@sinclair/typebox";

export type ToolSpec<T extends TSchema = TSchema> = {
  name: string;
  description: string;
  parameters: T;
};

export type Tool<T extends TSchema = TSchema, TResult = unknown> =
  ToolSpec<T> & {
    execute(args: Static<T>): Promise<TResult> | TResult;
  };
