import { describe, expect, test } from "bun:test";
import type { ToolCallContent } from "../../src/core";
import { stripTerminalControlSequences } from "../../src/tui/render";
import {
  buildFullToolDetail,
  formatFullToolDetail,
  formatToolInspector,
  type ToolDetail,
  type ToolDetailSection,
} from "../../src/tui/tools";

// Long values must clearly exceed summarizeText()'s 80-char threshold so the
// tests would fail if the detail layer ever summarized material data.
const LONG_COMMAND = `python -c '${"print('hello world');".repeat(500)}' --flag-with-a-long-name=value`;
const LONG_TEXT = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n");

function toolCall(name: string, args: unknown): ToolCallContent {
  return { type: "tool_call", id: `call-${name}`, name, args };
}

function sectionsOf(detail: ToolDetail): ToolDetailSection[] {
  return detail.sections;
}

describe("full-fidelity tool detail", () => {
  test("keeps a long bash command and cwd complete without summarizing", () => {
    const detail = buildFullToolDetail(
      toolCall("bash", { command: LONG_COMMAND, cwd: "deeply/nested/working/directory/for/tests" }),
    );

    expect(detail.title).toBe("Bash");
    expect(sectionsOf(detail)).toHaveLength(4);
    expect(detail.sections[0]).toEqual({ label: "Command", content: LONG_COMMAND });
    expect(detail.sections[1]).toEqual({
      label: "Working directory",
      content: "deeply/nested/working/directory/for/tests",
    });
    expect(detail.sections[2]).toEqual({ label: "Execution", content: "Foreground" });
    expect(detail.sections[3]).toEqual({ label: "Timeout", content: "30000 ms" });

    const formatted = formatFullToolDetail(detail);
    expect(formatted).toContain(LONG_COMMAND);
    expect(formatted).not.toContain("...");
  });

  test("expresses bash working-directory and timeout runtime defaults when omitted", () => {
    const detail = buildFullToolDetail(toolCall("bash", { command: "bun test" }));

    expect(detail.sections).toContainEqual({ label: "Working directory", content: "." });
    expect(detail.sections).toContainEqual({ label: "Execution", content: "Foreground" });
    expect(detail.sections).toContainEqual({ label: "Timeout", content: "30000 ms" });

    const explicit = buildFullToolDetail(
      toolCall("bash", { command: "bun test", cwd: "packages/cli", timeoutMs: 60_000 }),
    );
    expect(explicit.sections).toContainEqual({
      label: "Working directory",
      content: "packages/cli",
    });
    expect(explicit.sections).toContainEqual({ label: "Timeout", content: "60000 ms" });
  });

  test("shows effective background Bash parameters and launch result in the inspector", () => {
    const call = toolCall("bash", {
      command: "bun run dev",
      cwd: "apps/web",
      background: true,
    });
    const lines = formatToolInspector(
      call,
      {
        command: "bun run dev",
        cwd: "apps/web",
        background: true,
        jobId: "job_12345678",
        status: "running",
        stdout: "",
        stderr: "",
      },
      false,
      "done",
      100,
    );
    const text = stripTerminalControlSequences(lines.join("\n"));

    expect(text).toContain("Execution\n  Background");
    expect(text).toContain("Timeout\n  None");
    expect(text).toContain("Job ID\n  job_12345678");
    expect(text).toContain("Launch status\n  running");
  });

  test("keeps long write content complete instead of summarizeText()", () => {
    const content = `export const value = ${JSON.stringify(LONG_TEXT)};`;
    const detail = buildFullToolDetail(toolCall("write", { path: "src/generated.ts", content }));

    expect(detail.title).toBe("Write");
    expect(detail.sections[0]).toEqual({ label: "Path", content: "src/generated.ts" });
    expect(detail.sections[1]).toEqual({ label: "Content", content });
    expect(formatFullToolDetail(detail)).toContain(content);
  });

  test("keeps complete oldText and newText for edit with both sides present", () => {
    const oldText = `// TODO: remove this placeholder\n${LONG_TEXT}`;
    const newText = `// Implemented\n${LONG_TEXT}`;
    const detail = buildFullToolDetail(
      toolCall("edit", { path: "src/app.ts", oldText, newText, replaceAll: true }),
    );

    expect(detail.sections).toContainEqual({ label: "Path", content: "src/app.ts" });
    expect(detail.sections).toContainEqual({ label: "Replace", content: oldText });
    expect(detail.sections).toContainEqual({ label: "With", content: newText });
    expect(detail.sections).toContainEqual({
      label: "Replace all",
      content: "every occurrence in the file",
    });

    const formatted = formatFullToolDetail(detail);
    // Indented rows preserve every source line of both sides.
    expect(formatted).toContain("  // TODO: remove this placeholder");
    expect(formatted).toContain("  // Implemented");
    expect(formatted.split("line 120").length - 1).toBe(2);
  });

  test("expresses read line ranges with runtime defaults", () => {
    // Defaults: offset 1, limit DEFAULT_READ_LIMIT — the runtime never reads
    // "to the end of the file", so the reachable range is always explicit.
    const plain = buildFullToolDetail(toolCall("read", { path: "src/read.ts" }));
    expect(plain.sections).toContainEqual({ label: "Lines", content: "1-200" });

    const withOffsetOnly = buildFullToolDetail(
      toolCall("read", { path: "src/read.ts", offset: 40 }),
    );
    expect(withOffsetOnly.sections).toContainEqual({ label: "Lines", content: "40-239" });

    const withLimitOnly = buildFullToolDetail(toolCall("read", { path: "src/read.ts", limit: 50 }));
    expect(withLimitOnly.sections).toContainEqual({ label: "Lines", content: "1-50" });

    const withBoth = buildFullToolDetail(
      toolCall("read", { path: "src/read.ts", offset: 40, limit: 50 }),
    );
    expect(withBoth.sections).toContainEqual({ label: "Lines", content: "40-89" });
  });

  test("keeps complete arguments for custom and unknown tools without guessing a target", () => {
    const args = {
      target: "element-ref",
      command: LONG_COMMAND,
      nested: { items: Array.from({ length: 40 }, (_, index) => `entry-${index}`) },
    };
    const detail = buildFullToolDetail(toolCall("custom_lookup", args));

    expect(detail.title).toBe("custom_lookup");
    expect(detail.sections).toHaveLength(2);
    // The complete tool identity stays recoverable in the body because
    // fixed approval/inspector titles truncate to the viewport width.
    expect(detail.sections[0]).toEqual({ label: "Tool", content: "custom_lookup" });
    expect(detail.sections[1]?.label).toBe("Arguments");
    expect(detail.sections[1]?.content).toContain('"target": "element-ref"');
    expect(detail.sections[1]?.content).toContain('"entry-39"');
    expect(detail.sections[1]?.content).toContain(LONG_COMMAND);
  });

  test("sanitizes terminal control sequences in string arguments and nested values", () => {
    const detail = buildFullToolDetail(
      toolCall("custom_inject", {
        label: `safe\u001b]0;evil\u0007prefix`,
        nested: [`\u001b[31mred\u001b[0m`, "plain", "ctl\u0000\u001f"],
      }),
    );

    const content = detail.sections.find((section) => section.label === "Arguments")?.content ?? "";

    expect(content).toContain("safeprefix");
    expect(content).toContain("ctl");
    expect(content).not.toContain("\u001b");
    expect(content).not.toContain("\u0000");
    expect(content).not.toContain("\u001f");

    // The sanitizer behavior matches the render-layer definition.
    expect(content).toContain(stripTerminalControlSequences("\u001b[31mred\u001b[0m"));
  });

  test("carries MCP provenance and complete sanitized arguments", () => {
    const detail = buildFullToolDetail(
      toolCall("github_create_issue", {
        owner: "kana",
        body: `${LONG_TEXT}\u001b[2m`,
        labels: ["bug"],
      }),
      { kind: "mcp", serverId: "github", remoteToolName: "create_issue" },
    );

    expect(detail.title).toBe("MCP github · create_issue");
    expect(detail.sections).toEqual([
      { label: "Server", content: "github" },
      { label: "Tool", content: "create_issue" },
      {
        label: "Arguments",
        content: expect.stringContaining('"owner": "kana"'),
      },
    ]);
    expect(detail.sections[2]?.content).toContain(JSON.stringify(LONG_TEXT).slice(1, -1));
    expect(detail.sections[2]?.content).not.toContain("\u001b");
  });

  test("collapses line breaks in MCP provenance labels", () => {
    const detail = buildFullToolDetail(toolCall("mcp_tool", {}), {
      kind: "mcp",
      serverId: "evil\nserver",
      remoteToolName: "remote\u001b[31m",
    });

    expect(detail.sections[0]).toEqual({ label: "Server", content: "evil server" });
    expect(detail.sections[1]?.content).not.toContain("\u001b");
  });

  test("formats sections with labels, indented content, and blank separators", () => {
    const formatted = formatFullToolDetail({
      title: "Write",
      sections: [
        { label: "Path", content: "src/a.ts" },
        { label: "Content", content: "one\ntwo" },
      ],
    });

    expect(formatted).toBe("Path\n  src/a.ts\n\nContent\n  one\n  two");
  });

  test("keeps an empty write content visible with a blank content row", () => {
    const detail = buildFullToolDetail(toolCall("write", { path: "empty.ts", content: "" }));

    // path stays an ordinary non-empty field, content is a real payload that
    // happens to be empty — it must not collapse into a missing field.
    expect(detail.sections).toContainEqual({ label: "Path", content: "empty.ts" });
    expect(detail.sections).toContainEqual({ label: "Content", content: "" });
  });

  test("keeps an empty edit newText visible with a blank With row on a deletion", () => {
    const detail = buildFullToolDetail(
      toolCall("edit", { path: "foo.ts", oldText: "obsolete code", newText: "" }),
    );

    // The deletion intent is not recoverable if With vanishes: a blank
    // destination must keep its section.
    expect(detail.sections).toContainEqual({ label: "Path", content: "foo.ts" });
    expect(detail.sections).toContainEqual({ label: "Replace", content: "obsolete code" });
    expect(detail.sections).toContainEqual({ label: "With", content: "" });
    // The bare label row marks the empty destination without a sentinel.
    expect(formatFullToolDetail(detail)).toContain("With\n");
  });

  test("omits ordinary empty optional metadata but keeps material payloads", () => {
    // remember Title/Reason are optional metadata: an empty string is simply
    // absent, matching prior behavior — only material sections preserve empty.
    const remember = buildFullToolDetail(
      toolCall("remember", { content: "prefer tea", title: "" }),
    );
    expect(remember.sections.map((section) => section.label)).not.toContain("Title");

    const write = buildFullToolDetail(toolCall("write", { path: "empty.ts", content: "" }));
    expect(write.sections.map((section) => section.label)).toContain("Content");
  });

  test("expresses remember scope with the runtime default when omitted", () => {
    const withDefault = buildFullToolDetail(toolCall("remember", { content: "prefer tea" }));

    expect(withDefault.sections).toContainEqual({ label: "Scope", content: "project" });

    const withGlobal = buildFullToolDetail(
      toolCall("remember", { content: "prefer tea", scope: "global" }),
    );
    expect(withGlobal.sections).toContainEqual({ label: "Scope", content: "global" });
  });

  test("expresses grep match, case, and hidden-entry modes for defaults and overrides", () => {
    const defaults = buildFullToolDetail(toolCall("grep", { pattern: "TODO" }));

    expect(defaults.sections).toContainEqual({ label: "Match", content: "regular expression" });
    expect(defaults.sections).toContainEqual({ label: "Case", content: "sensitive" });
    expect(defaults.sections).toContainEqual({ label: "Hidden entries", content: "excluded" });
    expect(defaults.sections).toContainEqual({ label: "Path", content: "." });
    expect(defaults.sections).toContainEqual({ label: "Include", content: "**/*" });
    expect(defaults.sections).toContainEqual({ label: "Limit", content: "100" });

    const overrides = buildFullToolDetail(
      toolCall("grep", {
        pattern: "TODO",
        literal: true,
        caseSensitive: false,
        includeHidden: true,
        limit: 25,
      }),
    );

    expect(overrides.sections).toContainEqual({ label: "Match", content: "literal text" });
    expect(overrides.sections).toContainEqual({ label: "Case", content: "insensitive" });
    expect(overrides.sections).toContainEqual({ label: "Hidden entries", content: "included" });
    expect(overrides.sections).toContainEqual({ label: "Limit", content: "25" });
  });

  test("expresses list hidden-entry and limit semantics for defaults and overrides", () => {
    const defaults = buildFullToolDetail(toolCall("list", { path: "src" }));

    expect(defaults.sections).toContainEqual({ label: "Hidden entries", content: "included" });
    expect(defaults.sections).toContainEqual({ label: "Limit", content: "200" });

    const overrides = buildFullToolDetail(toolCall("list", { includeHidden: false, limit: 5 }));

    expect(overrides.sections).toContainEqual({ label: "Path", content: "." });
    expect(overrides.sections).toContainEqual({ label: "Hidden entries", content: "excluded" });
    expect(overrides.sections).toContainEqual({ label: "Limit", content: "5" });
  });

  test("expresses glob type, hidden-entry, and limit semantics for defaults and overrides", () => {
    const defaults = buildFullToolDetail(toolCall("glob", { pattern: "**/*.md" }));

    expect(defaults.sections).toContainEqual({ label: "Directory", content: "." });
    expect(defaults.sections).toContainEqual({ label: "Type", content: "file" });
    expect(defaults.sections).toContainEqual({ label: "Hidden entries", content: "excluded" });
    expect(defaults.sections).toContainEqual({ label: "Limit", content: "200" });
    expect(defaults.sections.map((section) => section.label)).not.toContain("Max depth");

    const overrides = buildFullToolDetail(
      toolCall("glob", {
        pattern: "**/*",
        type: "directory",
        includeHidden: true,
        limit: 8,
        maxDepth: 3,
      }),
    );

    expect(overrides.sections).toContainEqual({ label: "Type", content: "directory" });
    expect(overrides.sections).toContainEqual({ label: "Hidden entries", content: "included" });
    expect(overrides.sections).toContainEqual({ label: "Limit", content: "8" });
    expect(overrides.sections).toContainEqual({ label: "Max depth", content: "3" });
  });

  test("sanitizes unknown tool titles before they become renderable", () => {
    const detail = buildFullToolDetail(toolCall("evil\u001b[31mtool\nname", {}));

    expect(detail.title).toBe("eviltool name");
    expect(detail.title).not.toContain("\u001b");
    // The Tool section carries the same sanitized identity as the title.
    expect(detail.sections[0]).toEqual({ label: "Tool", content: "eviltool name" });
  });

  test("sanitizes the non-serializable argument fallback", () => {
    const evil = {
      toJSON: () => {
        throw new Error("not serializable");
      },
      toString: () => "hostile\u001b]0;owned\u0007payload",
    };
    const detail = buildFullToolDetail(toolCall("custom_hostile", evil));

    const argsSection = detail.sections.find((section) => section.label === "Arguments");
    expect(argsSection?.content).toBe("hostilepayload");
    expect(argsSection?.content).not.toContain("\u001b");
  });
});
