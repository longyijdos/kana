import type { Static, TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { isRecord } from "./record";

const validators = new WeakMap<TSchema, ReturnType<typeof Compile>>();

// Validates a decoded file or wire value against `schema` and reports the first
// error as `<path> <reason>.`. A schema node may set `errorMessage` to replace
// the generated reason for values at that node.
export function parseWithSchema<T extends TSchema>(
  schema: T,
  value: unknown,
  label: string,
): Static<T> {
  let validator = validators.get(schema);
  if (validator === undefined) {
    validator = Compile(schema);
    validators.set(schema, validator);
  }
  if (validator.Check(value)) {
    return value as Static<T>;
  }
  const [error] = validator.Errors(value);
  throw new Error(error ? formatSchemaError(schema, error, label) : `${label} is invalid.`);
}

function formatSchemaError(root: TSchema, error: TLocalizedValidationError, label: string): string {
  const segments = error.instancePath.split("/").slice(1).map(decodePointerSegment);
  const path = (keys: readonly string[]) => (keys.length === 0 ? label : keys.join("."));

  if (error.keyword === "additionalProperties") {
    const [key] = error.params.additionalProperties;
    return `Unknown ${label} field: ${path([...segments, String(key)])}.`;
  }
  if (error.keyword === "required") {
    const [key] = error.params.requiredProperties;
    return `${path([...segments, String(key)])} is required.`;
  }

  const custom = findSchemaAt(root, segments)?.errorMessage;
  if (typeof custom === "string") {
    return `${path(segments)} ${custom}.`;
  }
  return `${path(segments)} ${describeKeyword(error)}.`;
}

function describeKeyword(error: TLocalizedValidationError): string {
  switch (error.keyword) {
    case "type":
      return describeType(String(error.params.type));
    case "enum":
      return `must be one of: ${error.params.allowedValues.join(", ")}`;
    case "const":
      return `must be ${JSON.stringify(error.params.allowedValue)}`;
    case "minLength":
      return "must be a non-empty string";
    case "uniqueItems":
      return "must not contain duplicate values";
    default:
      return error.message;
  }
}

function describeType(type: string): string {
  switch (type) {
    case "object":
      return "must be an object";
    case "array":
      return "must be an array";
    case "integer":
      return "must be an integer";
    default:
      return `must be a ${type}`;
  }
}

type SchemaNode = { readonly [keyword: string]: unknown };

function findSchemaAt(root: TSchema, segments: readonly string[]): SchemaNode | undefined {
  let schema: SchemaNode | undefined = root as SchemaNode;
  for (const segment of segments) {
    if (schema === undefined) return undefined;
    const properties = schema.properties as Record<string, SchemaNode> | undefined;
    const patterns = schema.patternProperties as Record<string, SchemaNode> | undefined;
    const additional: unknown = schema.additionalProperties;
    schema =
      properties?.[segment] ??
      (patterns ? Object.values(patterns)[0] : undefined) ??
      (schema.items as SchemaNode | undefined) ??
      (isRecord(additional) ? additional : undefined);
  }
  return schema;
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}
