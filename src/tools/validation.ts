import type { Static, TSchema } from "@sinclair/typebox";
import { type TypeCheck, TypeCompiler } from "@sinclair/typebox/compiler";
import type { ValueError } from "@sinclair/typebox/errors";
import { Value } from "@sinclair/typebox/value";
import type { ToolCallContent } from "@/core";
import type { Tool } from "./tool";

const validatorCache = new WeakMap<object, TypeCheck<TSchema>>();

function getValidator(schema: TSchema): TypeCheck<TSchema> {
  const cached = validatorCache.get(schema);
  if (cached) {
    return cached;
  }

  // This project only accepts TypeBox schemas for tools, so compilation errors
  // should surface directly instead of being hidden behind JSON Schema fallbacks.
  const validator = TypeCompiler.Compile(schema);
  validatorCache.set(schema, validator);

  return validator;
}

function formatValidationPath(error: ValueError): string {
  const path = error.path.replace(/^\//, "").replace(/\//g, ".");
  return path || "root";
}

function formatValidationErrors(errors: Iterable<ValueError>): string {
  const formatted = [...errors]
    .map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
    .join("\n");

  return formatted || "Unknown validation error";
}

export function validateToolCall<T extends TSchema>(
  tools: Tool<T>[],
  toolCall: ToolCallContent,
): Static<T> {
  const tool = tools.find((candidate) => candidate.name === toolCall.name);

  if (!tool) {
    throw new Error(`Tool "${toolCall.name}" not found`);
  }

  return validateToolArguments(tool, toolCall.args);
}

export function validateToolArguments<T extends TSchema>(tool: Tool<T>, args: unknown): Static<T> {
  const converted = Value.Convert(tool.parameters, structuredClone(args));
  const validator = getValidator(tool.parameters);

  if (validator.Check(converted)) {
    return converted;
  }

  const errors = formatValidationErrors(validator.Errors(converted));
  const received = JSON.stringify(args, null, 2);

  throw new Error(
    `Validation failed for tool "${tool.name}":\n${errors}\n\nReceived arguments:\n${received}`,
  );
}
