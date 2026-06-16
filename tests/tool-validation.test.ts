import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { Tool } from "../src/tools/tool";
import { validateToolArguments, validateToolCall } from "../src/tools/validation";

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
});
