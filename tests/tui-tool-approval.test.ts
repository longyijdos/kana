import { describe, expect, test } from "bun:test";
import { ToolApproval } from "../src/tui/components";
import { stripAnsi } from "../src/tui/render/width";

describe("tool approval", () => {
  test("renders yes as the default selection", () => {
    const approval = new ToolApproval(
      {
        type: "tool_call",
        id: "call_1",
        name: "bash",
        args: {
          command: "bun test",
        },
      },
      () => {},
    );

    const rendered = approval.render(80).map(stripAnsi);

    expect(rendered).toContain("Allow agent to run bun test?");
    expect(rendered).toContain("bun test");
    expect(rendered).toContain("> Yes, run it");
    expect(rendered).toContain("  No, abort");
  });

  test("selects no with an arrow key and submits it with enter", () => {
    let decision: string | undefined;
    const approval = new ToolApproval(
      {
        type: "tool_call",
        id: "call_1",
        name: "bash",
        args: {
          command: "bun test",
        },
      },
      (nextDecision) => {
        decision = nextDecision;
      },
    );

    approval.handleInput("\x1b[A");
    approval.handleInput("\r");

    expect(decision).toBe("no");
  });
});
