import { describe, expect, test } from "bun:test";
import { ToolApproval } from "../src/tui/components";
import { stripAnsi } from "../src/tui/render";

describe("tool approval", () => {
  test("renders allow once as the default selection", () => {
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

    expect(rendered).toContain("Allow agent to run bash?");
    expect(rendered).toContain("bun test");
    expect(rendered).toContain("> Allow once");
    expect(rendered).toContain("  Deny");
  });

  test("renders the always allow option when enabled", () => {
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
      {
        allowAlways: true,
      },
    );

    const rendered = approval.render(80).map(stripAnsi);

    expect(rendered).toContain("> Allow once");
    expect(rendered).toContain("  Always allow this command");
    expect(rendered).toContain("  Deny");
  });

  test("wraps long bash command details for review", () => {
    const command = "bun test tests/tui-tool-approval.test.ts --timeout 30000 --rerun-each 2";
    const approval = new ToolApproval(
      {
        type: "tool_call",
        id: "call_1",
        name: "bash",
        args: {
          command,
        },
      },
      () => {},
    );

    const rendered = approval.render(28).map(stripAnsi);

    expect(rendered.join("")).toContain(command);
    expect(rendered.join("")).toContain("--rerun-each 2");
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

  test("renders multiline bash commands as separate logical lines", () => {
    const approval = new ToolApproval(
      {
        type: "tool_call",
        id: "call_1",
        name: "bash",
        args: {
          command:
            'git commit -m "feat: add something\n\nCo-authored-by: Name <email@example.com>"',
        },
      },
      () => {},
    );

    const rendered = approval.render(120).map(stripAnsi);

    expect(rendered.every((line) => !line.includes("\n") && !line.includes("\r"))).toBe(true);
    expect(rendered).toContain("Allow agent to run bash?");
    expect(rendered).toContain('git commit -m "feat: add something');
    expect(rendered).toContain('Co-authored-by: Name <email@example.com>"');
  });
});
