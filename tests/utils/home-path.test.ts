import { describe, expect, test } from "bun:test";
import path from "node:path";
import { expandHomePath } from "@/utils";

const HOME = path.join(path.sep, "home", "user");

describe("home path expansion", () => {
  test("expands a leading tilde to the home directory", () => {
    expect(expandHomePath("~", HOME)).toBe(HOME);
    expect(expandHomePath("~/", HOME)).toBe(HOME);
    expect(expandHomePath("~/notes.txt", HOME)).toBe(path.join(HOME, "notes.txt"));
    expect(expandHomePath("~//notes.txt", HOME)).toBe(path.join(HOME, "notes.txt"));
    expect(expandHomePath("~/nested/notes.txt", HOME)).toBe(path.join(HOME, "nested", "notes.txt"));
  });

  test("accepts a backslash separator only where the platform uses it", () => {
    const backslashInput = "~\\notes.txt";
    const expected = path.sep === "\\" ? path.join(HOME, "notes.txt") : backslashInput;

    expect(expandHomePath(backslashInput, HOME)).toBe(expected);
  });

  test("leaves paths without a leading home reference unchanged", () => {
    const literalPaths = [
      "notes.txt",
      path.join("nested", "~", "notes.txt"),
      "~notes/notes.txt",
      "~user/notes.txt",
      path.join(path.sep, "absolute", "~", "notes.txt"),
      "..",
    ];

    for (const literalPath of literalPaths) {
      expect(expandHomePath(literalPath, HOME), literalPath).toBe(literalPath);
    }
  });
});
