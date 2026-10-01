import { describe, expect, test } from "bun:test";
import type { Message } from "@/core";
import type { KanaSubagentInspection, KanaSubagentProfile, KanaSubagentSummary } from "@/kana";
import {
  createSubagentInspectionView,
  SubagentManager,
  type SubagentManagerAction,
} from "../../src/tui/components";
import { stripAnsi, visibleWidth } from "../../src/tui/render";
import { messageIdentityForTest } from "../helpers/messages";

describe("subagent manager", () => {
  test("shows configured profiles and routes run actions", () => {
    const actions: SubagentManagerAction[] = [];
    const manager = new SubagentManager((action) => actions.push(action));
    const completed = subagent("agent_complete", "completed");
    const running = subagent("agent_running1", "running");
    manager.replace([profile()], [completed, running]);
    manager.replacePreview({
      ...completed,
      output: "review\ncomplete",
      waitTimedOut: false,
      task: "Inspect the parser",
      messages: [reply("review\ncomplete")],
    });

    const rendered = stripAnsi(manager.render(100).join("\n"));
    expect(rendered).toContain("Profiles · explorer");
    expect(rendered).toContain("complete · explorer · completed");
    expect(rendered).toContain("review\ncomplete");

    manager.handleInput("K");
    manager.handleInput("\x1b[B");
    manager.handleInput("\x1b[A");
    manager.handleInput("\x1b[B");
    manager.handleInput("K");
    manager.handleInput("\r");
    manager.handleInput("R");
    manager.handleInput("\x1b");

    expect(actions).toEqual([
      { type: "select", subagent: running },
      { type: "select", subagent: completed },
      { type: "select", subagent: running },
      { type: "cancel", subagent: running },
      { type: "inspect", subagent: running },
      { type: "refresh" },
      { type: "close" },
    ]);
  });

  test("pages the selection by one window and reports each landed run once", () => {
    const actions: SubagentManagerAction[] = [];
    const manager = new SubagentManager((action) => actions.push(action));
    const runs = Array.from({ length: 8 }, (_, index) =>
      subagent(`agent_page${index}`, "completed"),
    );
    manager.replace([profile()], runs);

    manager.handleInput("\x1b[6~");
    expect(manager.selectedSubagent?.id).toBe("agent_page3");

    manager.handleInput("\x1b[4~");
    expect(manager.selectedSubagent?.id).toBe("agent_page7");

    manager.handleInput("\x1b[C");
    expect(manager.selectedSubagent?.id).toBe("agent_page7");

    manager.handleInput("\x1b[1~");
    expect(manager.selectedSubagent?.id).toBe("agent_page0");

    expect(actions).toEqual([
      { type: "select", subagent: runs[3] },
      { type: "select", subagent: runs[7] },
      { type: "select", subagent: runs[0] },
    ]);
  });

  test("keeps profiles on one line and reports names omitted by the terminal width", () => {
    const manager = new SubagentManager(() => {});
    manager.replace(
      [profile("explorer"), profile("reviewer"), profile("worker"), profile("auditor")],
      [],
    );

    const wide = manager.render(100).map(stripAnsi);
    expect(wide.filter((line) => line.startsWith("Profiles"))).toEqual([
      "Profiles · explorer · reviewer · worker · auditor",
    ]);
    expect(wide.join("\n")).not.toContain("Explore the repository");

    const narrow = manager.render(36).map(stripAnsi);
    const summary = narrow.find((line) => line.startsWith("Profiles"));
    expect(summary).toContain("explorer");
    expect(summary).toContain("+3 more");
    expect(visibleWidth(summary ?? "")).toBeLessThanOrEqual(36);
    expect(narrow.filter((line) => line.startsWith("Profiles"))).toHaveLength(1);
  });

  test("points at the role-card directory when no profile is configured", () => {
    const manager = new SubagentManager(() => {});
    manager.replace([], []);

    const rendered = stripAnsi(manager.render(100).join("\n"));
    expect(rendered).toContain("Profiles · none · add <KANA_HOME>/agents/<name>.md");
  });

  test("shows runs hidden before and after the viewport", () => {
    const manager = new SubagentManager(() => {});
    const runs = Array.from({ length: 7 }, (_, index) =>
      subagent(`agent_run0000${index}`, "running"),
    );
    manager.replace([profile()], runs);

    expect(stripAnsi(manager.render(100, 9).join("\n"))).toContain("... 3 more runs");

    for (let index = 0; index < 4; index += 1) manager.handleInput("\x1b[B");
    const scrolled = stripAnsi(manager.render(100, 9).join("\n"));
    expect(scrolled).toContain("... 2 earlier runs");
    expect(scrolled).toContain("... 2 more runs");
  });

  test("gives multiple runs priority and shrinks a truncated result preview", () => {
    const manager = new SubagentManager(() => {});
    const completed = subagent("agent_complete", "completed");
    manager.replace(
      [profile()],
      [
        completed,
        subagent("agent_running1", "running"),
        subagent("agent_running2", "running"),
        subagent("agent_running3", "running"),
      ],
    );
    manager.replacePreview({
      ...completed,
      output: `line one\nline two\nline three\n${"x".repeat(80)}`,
      waitTimedOut: false,
      task: "Inspect the parser",
      messages: [reply(`line one\nline two\nline three\n${"x".repeat(80)}`)],
    });

    const rendered = manager.render(100, 9).map(stripAnsi);
    expect(rendered.filter((line) => line.includes(" · explorer · "))).toHaveLength(4);
    expect(rendered).toContain("…");
    expect(rendered).toHaveLength(9);

    const narrow = manager.render(32).map(stripAnsi);
    expect(narrow).toContain("…");
    expect(narrow.some((line) => /^x+$/.test(line))).toBe(true);
    expect(narrow.slice(-4, -1).every((line) => visibleWidth(line) <= 32)).toBe(true);
  });

  test("shares ordered tool summaries and Markdown replies between detail and preview", () => {
    const inspection: KanaSubagentInspection = {
      ...subagent("agent_live", "running"),
      task: "Inspect the parser",
      output: "",
      waitTimedOut: false,
      messages: [
        {
          ...messageIdentityForTest("assistant"),
          role: "assistant",
          content: [
            { type: "thinking", text: "Private thinking" },
            { type: "text", text: "**Checking** the parser." },
            { type: "tool_call", id: "read-1", name: "read", args: { path: "src/parser.ts" } },
            {
              type: "tool_call",
              id: "shell-1",
              name: "shell",
              args: { command: "bun test", extra: "Hidden argument" },
            },
            {
              type: "tool_call",
              id: "mcp-1",
              name: "mcp_call",
              args: { server: "docs", tool: "lookup" },
            },
          ],
        },
        {
          ...messageIdentityForTest("tool"),
          role: "tool",
          toolCallId: "read-1",
          toolName: "read",
          content: "File body",
          result: {
            path: "src/parser.ts",
            content: "File body",
            startLine: 1,
            endLine: 10,
            totalLines: 10,
          },
          isError: false,
        },
        {
          ...messageIdentityForTest("tool"),
          role: "tool",
          toolCallId: "shell-1",
          toolName: "shell",
          content: "Failure output",
          result: { error: "Failure output" },
          isError: true,
        },
      ],
    };
    const view = createSubagentInspectionView(inspection);
    expect(view.title).toBe("Subagent explorer · running");
    const detail = view.render(100);
    expect(detail.map(stripAnsi)).toEqual([
      "Task: Inspect the parser",
      "",
      "Checking the parser.",
      "",
      "◆ Read",
      "  └ src/parser.ts",
      "",
      "◆ Failed to run",
      "  └ bun test",
      "",
      "◆ Calling MCP docs/lookup",
    ]);
    expect(detail.join("\n")).not.toContain("**Checking**");
    const manager = new SubagentManager(() => {});
    manager.replace([profile()], [inspection]);
    manager.replacePreview(inspection);
    const preview = manager.render(100).map(stripAnsi);
    expect(preview.slice(-4, -1)).toEqual(["…", "  └ bun test", "◆ Calling MCP docs/lookup"]);
  });

  for (const messages of [[], [reply("Partial parser review")]]) {
    test(`shows runtime errors in detail and preview with ${messages.length ? "partial" : "empty"} transcripts`, () => {
      const inspection: KanaSubagentInspection = {
        ...subagent("agent_failed", "errored"),
        task: "Inspect the parser",
        output: "",
        error: "Provider unavailable",
        waitTimedOut: false,
        messages,
      };
      const detail = createSubagentInspectionView(inspection).render(100).map(stripAnsi);
      expect(detail.at(-1)).toBe("Error: Provider unavailable");
      if (messages.length) expect(detail).toContain("Partial parser review");

      const manager = new SubagentManager(() => {});
      manager.replace([profile()], [inspection]);
      manager.replacePreview(inspection);
      const preview = manager.render(100).map(stripAnsi);
      expect(preview.at(-2)).toBe("Error: Provider unavailable");
    });
  }

  test("keeps hosted tool snapshots static and marks unfinished terminal calls canceled", () => {
    const inspection: KanaSubagentInspection = {
      ...subagent("agent_cancelled", "cancelled"),
      task: "Inspect",
      output: "",
      waitTimedOut: false,
      messages: [
        {
          ...messageIdentityForTest("assistant"),
          role: "assistant",
          content: [
            { type: "hosted_tool", id: "web-1", name: "web_search", status: "in_progress" },
            { type: "tool_call", id: "read-1", name: "read", args: { path: "src/parser.ts" } },
          ],
        },
      ],
    };
    const lines = createSubagentInspectionView(inspection).render(80).map(stripAnsi);
    expect(lines).toEqual([
      "Task: Inspect",
      "",
      "◆ Searching the web",
      "",
      "◆ Canceled reading",
      "  └ src/parser.ts",
    ]);
  });
});

function reply(text: string): Message {
  return {
    ...messageIdentityForTest("assistant"),
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text }],
  };
}

function profile(name = "explorer"): KanaSubagentProfile {
  return {
    name,
    description: "Explore the repository",
    instructions: "Inspect only.",
    tools: ["read"],
    digest: "digest",
  };
}

function subagent(id: string, status: KanaSubagentSummary["status"]): KanaSubagentSummary {
  return {
    id,
    profile: "explorer",
    label: "explorer: inspect parser",
    status,
    startedAt: new Date("2026-09-08T08:00:00.000Z"),
    ...(status === "running" ? {} : { finishedAt: new Date("2026-09-08T08:01:00.000Z") }),
  };
}
