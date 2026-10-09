import type { CodemodeJsonSchema } from "@earendil-works/pi-codemode";

const constraintKeys = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "default",
] as const;

function constraints(schema: CodemodeJsonSchema): string[] {
  if (typeof schema === "boolean") return [];
  const notes: string[] = [];
  if (schema.type === "integer") notes.push("integer");
  for (const key of constraintKeys) {
    if (schema[key] !== undefined) notes.push(`${key}: ${JSON.stringify(schema[key])}`);
  }
  if (schema.items !== undefined && !Array.isArray(schema.items)) {
    const items = constraints(schema.items as CodemodeJsonSchema);
    if (items.length) notes.push(`items: (${items.join("; ")})`);
  }
  return notes;
}

export function annotateInputSchema(schema: CodemodeJsonSchema): CodemodeJsonSchema {
  const copy = structuredClone(schema);
  visit(copy);
  return copy;
}

function visit(schema: CodemodeJsonSchema): void {
  if (typeof schema === "boolean") return;
  const notes = constraints(schema);
  if (notes.length) {
    schema.description = [schema.description, `Constraints: ${notes.join("; ")}.`]
      .filter(Boolean)
      .join("\n");
  }
  for (const key of ["properties", "patternProperties", "$defs", "definitions"]) {
    const children = schema[key] as Record<string, CodemodeJsonSchema> | undefined;
    if (children) for (const child of Object.values(children)) visit(child);
  }
  for (const key of ["items", "additionalProperties"]) {
    const child = schema[key] as CodemodeJsonSchema | CodemodeJsonSchema[] | undefined;
    if (Array.isArray(child)) child.forEach(visit);
    else if (child !== undefined) visit(child);
  }
  for (const key of ["prefixItems", "anyOf", "oneOf", "allOf"]) {
    const children = schema[key] as CodemodeJsonSchema[] | undefined;
    children?.forEach(visit);
  }
}
