import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";

const LEGACY_TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

type JsonSchemaObject = TSchema & {
  type?: string | string[];
  properties?: Record<string, JsonSchemaObject>;
  items?: JsonSchemaObject | JsonSchemaObject[];
  additionalProperties?: boolean | JsonSchemaObject;
  allOf?: JsonSchemaObject[];
  anyOf?: JsonSchemaObject[];
  oneOf?: JsonSchemaObject[];
};

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return isRecord(value);
}

export function hasTypeBoxMetadata(schema: unknown): boolean {
  return (
    isRecord(schema) &&
    (typeof schema["~kind"] === "string" ||
      Object.getOwnPropertySymbols(schema).includes(LEGACY_TYPEBOX_KIND))
  );
}

function getSchemaTypes(schema: JsonSchemaObject): string[] {
  if (typeof schema.type === "string") {
    return [schema.type];
  }

  return Array.isArray(schema.type)
    ? schema.type.filter((type): type is string => typeof type === "string")
    : [];
}

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value) && !Array.isArray(value);
    default:
      return false;
  }
}

function coercePrimitive(value: unknown, type: string): unknown {
  switch (type) {
    case "number": {
      if (value === null) {
        return 0;
      }
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : value;
      }
      if (typeof value === "boolean") {
        return value ? 1 : 0;
      }
      return value;
    }
    case "integer": {
      if (value === null) {
        return 0;
      }
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        return Number.isInteger(parsed) ? parsed : value;
      }
      if (typeof value === "boolean") {
        return value ? 1 : 0;
      }
      return value;
    }
    case "boolean": {
      if (value === null) {
        return false;
      }
      if (value === "true" || value === 1) {
        return true;
      }
      if (value === "false" || value === 0) {
        return false;
      }
      return value;
    }
    case "string":
      if (value === null) {
        return "";
      }
      return typeof value === "number" || typeof value === "boolean" ? String(value) : value;
    case "null":
      return value === "" || value === 0 || value === false ? null : value;
    default:
      return value;
  }
}

function applyObjectCoercion(value: Record<PropertyKey, unknown>, schema: JsonSchemaObject): void {
  const properties = schema.properties;
  const definedKeys = new Set(properties ? Object.keys(properties) : []);

  if (properties) {
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in value) {
        value[key] = coerceJsonSchemaValue(value[key], propertySchema);
      }
    }
  }

  if (isJsonSchemaObject(schema.additionalProperties)) {
    for (const [key, propertyValue] of Object.entries(value)) {
      if (!definedKeys.has(key)) {
        value[key] = coerceJsonSchemaValue(propertyValue, schema.additionalProperties);
      }
    }
  }
}

function applyArrayCoercion(value: unknown[], schema: JsonSchemaObject): void {
  if (Array.isArray(schema.items)) {
    for (let index = 0; index < value.length; index += 1) {
      const itemSchema = schema.items[index];
      if (itemSchema) {
        value[index] = coerceJsonSchemaValue(value[index], itemSchema);
      }
    }
    return;
  }

  if (isJsonSchemaObject(schema.items)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = coerceJsonSchemaValue(value[index], schema.items);
    }
  }
}

function coerceUnion(value: unknown, schemas: JsonSchemaObject[]): unknown {
  for (const schema of schemas) {
    const candidate = coerceJsonSchemaValue(structuredClone(value), schema);

    try {
      if (Compile(schema).Check(candidate)) {
        return candidate;
      }
    } catch {
      // The outer validator will report unsupported or malformed schemas. A
      // union branch that cannot compile is not safe to select for coercion.
    }
  }

  return value;
}

// TypeBox metadata is not preserved by JSON serialization. Its validator can
// compile the resulting JSON Schema, but Value.Convert cannot infer how to
// coerce it, so reproduce the compatible primitive conversions recursively.
export function coerceJsonSchemaValue(value: unknown, schema: JsonSchemaObject): unknown {
  let coerced = value;

  if (Array.isArray(schema.allOf)) {
    for (const nested of schema.allOf) {
      coerced = coerceJsonSchemaValue(coerced, nested);
    }
  }

  if (Array.isArray(schema.anyOf)) {
    coerced = coerceUnion(coerced, schema.anyOf);
  }
  if (Array.isArray(schema.oneOf)) {
    coerced = coerceUnion(coerced, schema.oneOf);
  }

  const schemaTypes = getSchemaTypes(schema);
  const alreadyMatchesUnion =
    schemaTypes.length > 1 && schemaTypes.some((type) => matchesJsonType(coerced, type));

  if (schemaTypes.length > 0 && !alreadyMatchesUnion) {
    for (const type of schemaTypes) {
      const candidate = coercePrimitive(coerced, type);
      if (candidate !== coerced) {
        coerced = candidate;
        break;
      }
    }
  }

  if (schemaTypes.includes("object") && isRecord(coerced) && !Array.isArray(coerced)) {
    applyObjectCoercion(coerced, schema);
  }
  if (schemaTypes.includes("array") && Array.isArray(coerced)) {
    applyArrayCoercion(coerced, schema);
  }

  return coerced;
}
