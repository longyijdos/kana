import type { TSchema } from "typebox";

export type ToolConcurrency = "parallel" | "exclusive";

export type ToolExecutionPolicy = {
  concurrency?: ToolConcurrency;
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
