import { describe, expect, test } from "bun:test";
import type { KanaSubagentProfile, KanaSubagentSummary } from "@/kana";
import { SubagentManager, type SubagentManagerAction } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";

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
    expect(rendered).toContain("explorer (builtin) · Explore the repository");
    expect(rendered).toContain("complete · explorer · completed");
    expect(rendered).toContain("review\ncomplete");

    manager.handleInput("K");
    manager.handleInput("\x1b[B");
    manager.handleInput("K");
    manager.handleInput("\r");
    manager.handleInput("R");
    manager.handleInput("\x1b");

    expect(actions).toEqual([
      { type: "select", subagent: running },
      { type: "cancel", subagent: running },
      { type: "inspect", subagent: running },
      { type: "refresh" },
      { type: "close" },
    ]);
  });
});

function profile(): KanaSubagentProfile {
  return {
    name: "explorer",
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
