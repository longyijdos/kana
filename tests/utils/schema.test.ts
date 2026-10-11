import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { parseWithSchema } from "@/utils";

const schema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    mode: Type.Optional(Type.Enum(["a", "b"])),
    limit: Type.Optional(Type.Integer({ minimum: 1, errorMessage: "must be a positive integer" })),
    nested: Type.Optional(Type.Object({ flag: Type.Boolean() }, { additionalProperties: false })),
  },
  { additionalProperties: false },
);

describe("parseWithSchema", () => {
  test("returns the validated value", () => {
    const value: unknown = { name: "x", mode: "a" };
    expect(parseWithSchema(schema, value, "file") as unknown).toBe(value);
  });

  test.each([
    [{}, "name is required."],
    [{ name: "" }, "name must be a non-empty string."],
    [{ name: "x", mode: "c" }, "mode must be one of: a, b."],
    [{ name: "x", limit: 0 }, "limit must be a positive integer."],
    [{ name: "x", nested: { flag: "yes" } }, "nested.flag must be a boolean."],
    [{ name: "x", nested: { flag: true, extra: 1 } }, "Unknown file field: nested.extra."],
    [[], "file must be an object."],
  ])("reports %j", (value, message) => {
    expect(() => parseWithSchema(schema, value, "file")).toThrow(message);
  });
});
