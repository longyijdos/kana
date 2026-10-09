import { describe, expect, test } from "bun:test";
import { annotateInputSchema } from "../../src/tools/codemode/schema-annotations";

describe("codemode schema annotations", () => {
  test.each([
    [
      { type: "integer", minimum: 0, maximum: 30000, default: 0 },
      "integer; minimum: 0; maximum: 30000; default: 0",
    ],
    [
      { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1, multipleOf: 0.1 },
      "exclusiveMinimum: 0; exclusiveMaximum: 1; multipleOf: 0.1",
    ],
    [
      {
        type: "string",
        minLength: 1,
        maxLength: 20,
        pattern: "^[a-z]+$",
        format: "email",
        default: "a",
      },
      'minLength: 1; maxLength: 20; pattern: "^[a-z]+$"; format: "email"; default: "a"',
    ],
    [
      {
        type: "array",
        minItems: 1,
        maxItems: 3,
        uniqueItems: true,
        items: { type: "integer", minimum: 0 },
      },
      "minItems: 1; maxItems: 3; uniqueItems: true; items: (integer; minimum: 0)",
    ],
    [{ type: "boolean", default: false }, "default: false"],
    [{ type: ["string", "null"], default: null }, "default: null"],
  ])("renders constraints for %j", (schema, summary) => {
    expect(annotateInputSchema(schema)).toMatchObject({ description: `Constraints: ${summary}.` });
  });

  test("preserves descriptions and annotates nested schemas without mutating the original", () => {
    const schema = {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              wait: { type: "integer", description: "Wait in milliseconds.", minimum: 0 },
            },
          },
        },
        count: { $ref: "#/$defs/Count" },
        plain: { type: "string" },
      },
      $defs: { Count: { type: "integer", maximum: 10 } },
    };
    const original = structuredClone(schema);
    expect(annotateInputSchema(schema)).toMatchObject({
      properties: {
        rows: {
          items: {
            properties: {
              wait: { description: "Wait in milliseconds.\nConstraints: integer; minimum: 0." },
            },
          },
        },
        plain: { type: "string" },
      },
      $defs: { Count: { description: "Constraints: integer; maximum: 10." } },
    });
    expect(schema).toEqual(original);
    expect(annotateInputSchema({ type: "string" })).toEqual({ type: "string" });
    expect(annotateInputSchema(true)).toBe(true);
    expect(annotateInputSchema(false)).toBe(false);
  });
});
