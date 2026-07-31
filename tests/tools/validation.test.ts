import { describe, expect, test } from "bun:test";
import { type TSchema, Type } from "typebox";
import type { Tool } from "../../src/tools/tool";
import { validateToolArguments, validateToolCall } from "../../src/tools/validation";

const addParameters = Type.Object({
  a: Type.Number(),
  b: Type.Number(),
});

const addTool = {
  name: "add",
  description: "Add two numbers.",
  parameters: addParameters,
  execute: ({ a, b }) => a + b,
} satisfies Tool<typeof addParameters, number>;

function createPlainSchemaTool(parameters: TSchema): Tool<TSchema> {
  return {
    name: "plain_schema",
    description: "Validate arguments described by serialized JSON Schema.",
    parameters,
    execute: () => undefined,
  };
}

describe("tool validation", () => {
  test("converts and validates TypeBox tool arguments", () => {
    const args = {
      a: "1",
      b: 2,
    };

    const validated = validateToolArguments(addTool, args);

    expect(validated).toEqual({
      a: 1,
      b: 2,
    });
    expect(args).toEqual({
      a: "1",
      b: 2,
    });
  });

  test("validates tool call arguments by tool name", () => {
    const validated = validateToolCall([addTool], {
      type: "tool_call",
      id: "call_1",
      name: "add",
      args: {
        a: 3,
        b: "4",
      },
    });

    expect(validated).toEqual({
      a: 3,
      b: 4,
    });
  });

  test("throws when the tool does not exist", () => {
    expect(() =>
      validateToolCall([addTool], {
        type: "tool_call",
        id: "call_1",
        name: "missing",
        args: {},
      }),
    ).toThrow('Tool "missing" not found');
  });

  test("throws formatted validation errors", () => {
    expect(() => validateToolArguments(addTool, { a: 1 })).toThrow(
      'Validation failed for tool "add":',
    );
    expect(() => validateToolArguments(addTool, { a: 1 })).toThrow("b: Expected required property");
  });

  test("converts arguments described by serialized TypeBox schemas", () => {
    const serialized = JSON.parse(
      JSON.stringify(
        Type.Object({
          count: Type.Number(),
          options: Type.Object({
            enabled: Type.Boolean(),
          }),
          values: Type.Array(Type.Integer()),
        }),
      ),
    ) as TSchema;
    const tool = createPlainSchemaTool(serialized);

    expect(
      validateToolArguments(tool, {
        count: "42",
        options: {
          enabled: "true",
        },
        values: ["1", 2],
      }),
    ).toEqual({
      count: 42,
      options: {
        enabled: true,
      },
      values: [1, 2],
    });
  });

  test("validates plain JSON Schema references", () => {
    const parameters = {
      type: "object",
      properties: {
        value: {
          $ref: "#/$defs/value",
        },
      },
      required: ["value"],
      $defs: {
        value: {
          type: "string",
          minLength: 2,
        },
      },
    } as TSchema;
    const tool = createPlainSchemaTool(parameters);

    expect(validateToolArguments(tool, { value: "ok" })).toEqual({ value: "ok" });
    expect(() => validateToolArguments(tool, { value: 1 })).toThrow("must be string");
    expect(() => validateToolArguments(tool, { value: "x" })).toThrow(
      "must not have fewer than 2 characters",
    );
  });
});
