import type { Static, TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import type { ToolCallContent } from "@/core";
import { coerceJsonSchemaValue, hasTypeBoxMetadata } from "./json-schema-coercion";
import type { Tool } from "./tool";

const validatorCache = new WeakMap<object, ReturnType<typeof Compile>>();

function getValidator(schema: TSchema): ReturnType<typeof Compile> {
  const cached = validatorCache.get(schema);
  if (cached) {
    return cached;
  }

  const validator = Compile(schema);
  validatorCache.set(schema, validator);

  return validator;
}

export function precompileToolParameters<T extends TSchema>(schema: T): T {
  getValidator(schema);
  return schema;
}

function formatValidationPath(error: TLocalizedValidationError): string {
  if (error.keyword === "required") {
    const requiredProperty = error.params.requiredProperties[0];
    if (requiredProperty) {
      const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
      return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
    }
  }

  const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
  return path || "root";
}

function formatValidationMessage(error: TLocalizedValidationError): string {
  // Preserve the existing model-facing wording across the TypeBox migration.
  return error.keyword === "required" ? "Expected required property" : error.message;
}

function formatValidationErrors(errors: TLocalizedValidationError[]): string {
  const formatted = errors
    .map((error) => `  - ${formatValidationPath(error)}: ${formatValidationMessage(error)}`)
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
  let converted = Value.Convert(tool.parameters, structuredClone(args));

  if (!hasTypeBoxMetadata(tool.parameters)) {
    converted = coerceJsonSchemaValue(converted, tool.parameters);
  }

  const validator = getValidator(tool.parameters);

  if (validator.Check(converted)) {
    return converted as Static<T>;
  }

  const errors = formatValidationErrors(validator.Errors(converted));
  const received = JSON.stringify(args, null, 2);

  throw new Error(
    `Validation failed for tool "${tool.name}":\n${errors}\n\nReceived arguments:\n${received}`,
  );
}
