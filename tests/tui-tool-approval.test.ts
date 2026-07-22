import { describe, expect, test } from "bun:test";
import { ToolApproval } from "../src/tui/components";
import { color, stripAnsi } from "../src/tui/render";
import { tuiTheme } from "../src/tui/theme";

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

    const rawRendered = approval.render(80);
    const rendered = rawRendered.map(stripAnsi);

    expect(rendered).toContain("Allow agent to run bash?");
    expect(rendered).toContain("bun test");
    expect(rendered).toContain("> Allow once");
    expect(rendered).toContain("  Deny");
    expect(rawRendered[0]).toBe(color("Allow agent to run bash?", tuiTheme.toolActive));
    expect(rawRendered.find((line) => line.includes("Allow once"))).toBe(
      color("> Allow once", tuiTheme.user),
    );
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

  test("renders MCP provenance and complete formatted arguments", () => {
    const approval = new ToolApproval(
      {
        type: "tool_call",
        id: "call_1",
        name: "github_create_issue",
        args: {
          owner: "kana",
          issue: { title: "Fix startup", labels: ["bug"] },
        },
      },
      () => {},
      {
        source: {
          kind: "mcp",
          serverId: "github",
          remoteToolName: "create_issue",
        },
      },
    );

    const rendered = approval.render(80).map(stripAnsi);
    const detail = rendered.join("\n");

    expect(rendered).toContain("Allow MCP tool?");
    expect(rendered).toContain("Server: github");
    expect(rendered).toContain("Tool: create_issue");
    expect(rendered).toContain("Arguments:");
    expect(detail).toContain('"owner": "kana"');
    expect(detail).toContain('"title": "Fix startup"');
    expect(detail).toContain('"labels": [');
    expect(rendered).toContain("> Allow once");
    expect(rendered).not.toContain("  Always allow this command");
    expect(rendered).toContain("  Deny");
  });

  test("distinguishes write overwrite approvals from new file writes", () => {
    const approval = new ToolApproval(
      {
        type: "tool_call",
        id: "call_1",
        name: "write",
        args: {
          path: "notes.txt",
          content: "replacement",
          overwrite: true,
        },
      },
      () => {},
    );

    const rendered = approval.render(80).map(stripAnsi);
    const rawRendered = approval.render(80).join("\n");

    expect(rendered).toContain("Allow agent to create file? [OVERWRITE]");
    expect(rendered.join("\n")).toContain("notes.txt - replacement");
    expect(rendered.join("\n")).not.toContain("replacement - [OVERWRITE]");
    expect(rawRendered).toContain(color("[OVERWRITE]", tuiTheme.error));
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
