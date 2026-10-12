import { describe, expect, test } from "bun:test";
import { readFrontmatter } from "../../src/kana/frontmatter";

describe("readFrontmatter", () => {
  test("reads scalars, quoted values, indented blocks, and lists", () => {
    const content = [
      "---",
      "# comment",
      'name: "quoted"',
      "plain: value",
      "description: |",
      "  first",
      "  second",
      "tools:",
      "  - read",
      "  - 'shell'",
      "---",
      "Body",
    ].join("\r\n");

    expect(readFrontmatter(content)).toEqual({
      fields: {
        name: "quoted",
        plain: "value",
        description: "first\nsecond",
        tools: ["read", "shell"],
      },
      body: "\nBody",
    });
  });

  test("returns undefined without frontmatter and accepts a closing marker at EOF", () => {
    expect(readFrontmatter("plain markdown")).toBeUndefined();
    expect(readFrontmatter("---\nkey: value\n---")).toEqual({ fields: { key: "value" }, body: "" });
  });

  test.each([
    ["---\nkey: value\n", "missing a closing --- marker"],
    ["---\nnot a field\n---\n", "invalid frontmatter line: not a field"],
    ["---\nkey: a\nkey: b\n---\n", "key is declared more than once"],
    ["---\nkey: a\n  nested: b\n---\n", "invalid frontmatter line:   nested: b"],
  ])("rejects %j", (content, message) => {
    expect(() => readFrontmatter(content)).toThrow(message);
  });
});
