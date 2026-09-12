import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expandKanaPromptTemplate, getKanaConfigPaths, loadKanaPromptTemplates } from "@/kana";
import { cleanupConfigTempDirs, createTempEnv } from "../config/config-fixture";

afterEach(cleanupConfigTempDirs);

describe("Kana prompt templates", () => {
  test("loads named Markdown templates and discovers placeholders", () => {
    const env = createTempEnv();
    const directory = getKanaConfigPaths(env).promptTemplatesDirectory;
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "review.md"),
      [
        "---",
        'description: "Review a selected area"',
        "---",
        "Review {{scope=the current change}} against {{base}}.",
        "Check {{base}} again.",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(directory, "cleanup.md"),
      "---\ndescription: Clean merged work\n---\nClean the merged branch.\n",
    );
    writeFileSync(path.join(directory, ".hidden.md"), "ignored");
    writeFileSync(path.join(directory, "template.md.example"), "ignored");
    writeFileSync(path.join(directory, "notes.txt"), "ignored");

    const loaded = loadKanaPromptTemplates({ env });

    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.templates.map((template) => template.name)).toEqual(["cleanup", "review"]);
    expect(loaded.templates[1]).toEqual({
      name: "review",
      description: "Review a selected area",
      body: "Review {{scope=the current change}} against {{base}}.\nCheck {{base}} again.",
      arguments: [{ name: "scope", defaultValue: "the current change" }, { name: "base" }],
      sourcePath: path.join(directory, "review.md"),
    });
  });

  test("expands defaults and quoted named arguments", () => {
    const template = {
      name: "review",
      description: "Review a selected area",
      body: "Review {{scope=the current change}} against {{base}}.",
      arguments: [{ name: "scope", defaultValue: "the current change" }, { name: "base" }],
      sourcePath: "/tmp/review.md",
    };

    expect(expandKanaPromptTemplate(template, "base=main")).toBe(
      "Review the current change against main.",
    );
    expect(expandKanaPromptTemplate(template, 'base=develop scope="session handling"')).toBe(
      "Review session handling against develop.",
    );
    expect(expandKanaPromptTemplate(template, "base='' scope=")).toBe("Review  against .");
  });

  test("reports invalid templates without hiding valid siblings", () => {
    const env = createTempEnv();
    const directory = getKanaConfigPaths(env).promptTemplatesDirectory;
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "valid.md"),
      "---\ndescription: Valid template\n---\nRun the task.\n",
    );
    writeFileSync(path.join(directory, "Bad_Name.md"), "---\ndescription: Bad\n---\nBad.\n");
    writeFileSync(
      path.join(directory, "conflict.md"),
      "---\ndescription: Conflict\n---\n{{base=main}} {{base=develop}}\n",
    );
    writeFileSync(path.join(directory, "empty.md"), "---\ndescription: Empty\n---\n");

    const loaded = loadKanaPromptTemplates({ env });

    expect(loaded.templates.map((template) => template.name)).toEqual(["valid"]);
    expect(loaded.diagnostics).toHaveLength(3);
    expect(loaded.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "invalid_template",
      "invalid_template",
      "invalid_template",
    ]);
  });

  test("rejects missing, unknown, duplicate, and malformed arguments", () => {
    const template = {
      name: "cleanup",
      description: "Cleanup",
      body: "Clean {{branch}} from {{base=main}}.",
      arguments: [{ name: "branch" }, { name: "base", defaultValue: "main" }],
      sourcePath: "/tmp/cleanup.md",
    };

    expect(() => expandKanaPromptTemplate(template, "")).toThrow("branch=<value>");
    expect(() => expandKanaPromptTemplate(template, "branch=one extra=value")).toThrow(
      'no argument named "extra"',
    );
    expect(() => expandKanaPromptTemplate(template, "branch=one branch=two")).toThrow(
      'argument "branch" more than once',
    );
    expect(() => expandKanaPromptTemplate(template, 'branch="unfinished')).toThrow(
      "expects name=value arguments",
    );
    expect(() => expandKanaPromptTemplate(template, "branch one")).toThrow(
      "expects name=value arguments",
    );
  });
});
