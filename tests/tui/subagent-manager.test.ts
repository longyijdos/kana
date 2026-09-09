import { describe, expect, test } from "bun:test";
import type { KanaSubagentProfile, KanaSubagentSummary } from "@/kana";
import { SubagentManager, type SubagentManagerAction } from "../../src/tui/components";
import { stripAnsi, visibleWidth } from "../../src/tui/render";

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
    expect(wide.join("\n")).not.toContain("builtin");
    expect(wide.join("\n")).not.toContain("Explore the repository");

    const narrow = manager.render(36).map(stripAnsi);
    const summary = narrow.find((line) => line.startsWith("Profiles"));
    expect(summary).toContain("explorer");
    expect(summary).toContain("+3 more");
    expect(visibleWidth(summary ?? "")).toBeLessThanOrEqual(36);
    expect(narrow.filter((line) => line.startsWith("Profiles"))).toHaveLength(1);
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
      output: "line one\nline two\nline three\nline four",
      waitTimedOut: false,
    });

    const rendered = manager.render(100, 9).map(stripAnsi);
    expect(rendered.filter((line) => line.includes(" · explorer · "))).toHaveLength(4);
    expect(rendered).toContain("…");
    expect(rendered).toHaveLength(9);
  });
});

function profile(name = "explorer"): KanaSubagentProfile {
  return {
    name,
    description: "Explore the repository",
    instructions: "Inspect only.",
    tools: ["read"],
    source: "builtin",
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
