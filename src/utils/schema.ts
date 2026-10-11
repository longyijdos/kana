import { type Static, type TProperties, type TSchema, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { isRecord } from "./record";

export const strictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const nonEmptyString = () =>
  Type.String({ pattern: "\\S", errorMessage: "must be a non-empty string" });

export const positiveInteger = () =>
  Type.Integer({ minimum: 1, errorMessage: "must be a positive integer" });

const validators = new WeakMap<TSchema, ReturnType<typeof Compile>>();

// Validates a decoded file or wire value against `schema` and reports the first
// error as `<label>.<path> <reason>.`. A schema node may set `errorMessage` to
// replace the generated reason for values at that node.
export function parseWithSchema<T extends TSchema>(
  schema: T,
  value: unknown,
  label: string,
): Static<T> {
  const validator = getValidator(schema);
  if (validator.Check(value)) {
    return value as Static<T>;
  }
  const [error] = validator.Errors(value);
  throw new Error(error ? formatSchemaError(schema, error, label) : `${label} is invalid.`);
}

function getValidator(schema: TSchema): ReturnType<typeof Compile> {
  let validator = validators.get(schema);
  if (validator === undefined) {
    validator = Compile(schema);
    validators.set(schema, validator);
  }
  return validator;
}

function formatSchemaError(root: TSchema, error: TLocalizedValidationError, label: string): string {
  const segments = error.instancePath.split("/").slice(1).map(decodePointerSegment);
  const path = formatPath(label, segments);

  if (error.keyword === "additionalProperties") {
    return `${path} contains unknown field ${error.params.additionalProperties[0]}.`;
  }
  if (error.keyword === "required") {
    return `${formatPath(label, [...segments, String(error.params.requiredProperties[0])])} is required.`;
  }

  const custom = findSchemaAt(root, segments)?.errorMessage;
  return `${path} ${typeof custom === "string" ? custom : describeKeyword(error)}.`;
}

function formatPath(label: string, segments: readonly string[]): string {
  return segments.reduce(
    (path, segment) => (/^\d+$/.test(segment) ? `${path}[${segment}]` : `${path}.${segment}`),
    label,
  );
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
