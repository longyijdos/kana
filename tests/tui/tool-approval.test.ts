import { describe, expect, test } from "bun:test";
import { ToolApproval } from "../../src/tui/components";
import { color, stripAnsi } from "../../src/tui/render";
import { tuiTheme } from "../../src/tui/theme";
import { formatToolApproval } from "../../src/tui/tools";

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
    expect(rendered).toContain("Command");
    expect(rendered).toContain("  bun test");
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

  test("renders MCP provenance in the approval layout", () => {
    const approval = new ToolApproval(
      {
        type: "tool_call",
        id: "call_1",
        name: "github_create_issue",
        args: { owner: "kana" },
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
    expect(rendered).toContain("Allow MCP tool?");
    expect(rendered).toContain("Server");
    expect(rendered).toContain("  github");
    expect(rendered).toContain("Tool");
    expect(rendered).toContain("  create_issue");
    expect(rendered).toContain("Arguments");
    expect(rendered.join("\n")).toContain('"owner": "kana"');
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
    expect(rendered).toContain("Path");
    expect(rendered).toContain("  notes.txt");
    expect(rendered).toContain("Content");
    expect(rendered).toContain("  replacement");
    expect(rendered).toContain("Overwrite");
    expect(rendered).toContain("  replaces the existing file");
    // The overwrite marker lives only in the approval title, never inside
    // the full-fidelity detail body.
    expect(rendered.filter((line) => line.includes("[OVERWRITE]"))).toEqual([
      "Allow agent to create file? [OVERWRITE]",
    ]);
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

    expect(rendered).toContain("Command");
    expect(rendered.join("")).toContain(command);
    expect(rendered.join("")).toContain("--rerun-each 2");
  });

  test("denies with escape", () => {
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

    approval.handleInput("\x1b");

    expect(decision).toBe("no");
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
    expect(rendered).toContain("Command");
    expect(rendered).toContain('  git commit -m "feat: add something');
    expect(rendered).toContain('  Co-authored-by: Name <email@example.com>"');
  });

  test("keeps a very long custom tool name recoverable when the approval title truncates", () => {
    const toolName = `custom_${"segment-".repeat(40)}END-OF-NAME`;
    const toolCall = {
      type: "tool_call" as const,
      id: "call_1",
      name: toolName,
      args: { value: 1 },
    };
    const approval = new ToolApproval(toolCall, () => {});

    // The fixed approval title is one row truncated to the viewport width,
    // so the complete name cannot appear anywhere in the narrow render.
    const narrow = approval.render(30).map(stripAnsi);
    const titleLine = narrow.find((line) => line.startsWith("Allow agent to use"));
    expect(titleLine).toBeDefined();
    expect((titleLine ?? "").length).toBeLessThanOrEqual(30);
    expect(narrow.join("\n")).not.toContain(toolName);

    // The complete sanitized identity lives in the approval detail itself...
    expect(formatToolApproval(toolCall).detail).toContain(toolName);

    // ...and paging a bounded viewport recovers it.
    let recovered = false;
    for (let page = 0; page < 8 && !recovered; page += 1) {
      recovered = approval.render(80, 10).map(stripAnsi).join("\n").includes("END-OF-NAME");
      if (!recovered) {
        approval.handleInput("\x1b[C");
      }
    }
    expect(recovered).toBe(true);
  });

  test("keeps malicious custom tool data out of rendered terminal controls", () => {
    const toolCall = {
      type: "tool_call" as const,
      id: "call_1",
      name: "evil\u001b]0;owned\u0007tool\nname\u001f",
      args: { value: "safe\u001b[31mred\u001b[0m" },
    };

    const approval = new ToolApproval(toolCall, () => {});
    const rendered = approval.render(80).map(stripAnsi);
    const output = rendered.join("\n");

    expect(rendered).toContain("Allow agent to use eviltool name?");
    expect(output).toContain("  eviltool name");
    expect(output).toContain('"value": "safered"');
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u0007");
    expect(output).not.toContain("\u001f");
  });

  test("pages long write approval detail within the bounded height", () => {
    const content = Array.from({ length: 40 }, (_, index) => `// block line ${index + 1}`).join(
      "\n",
    );
    const approval = new ToolApproval(
      {
        type: "tool_call",
        id: "call_1",
        name: "write",
        args: { path: "src/big.ts", content },
      },
      () => {},
    );

    const firstPage = approval.render(40, 12).map(stripAnsi);

    expect(firstPage.length).toBeLessThanOrEqual(12);
    expect(firstPage.some((line) => line.endsWith("detail lines below"))).toBe(true);
    expect(firstPage).toContain("Left/Right page detail");
    expect(firstPage).toContain("  // block line 1");
    expect(firstPage).not.toContain("  // block line 40");
    expect(firstPage).toContain("> Allow once");
    expect(firstPage).toContain("  Deny");

    // Right/PageDown paging recovers the complete tail without ever
    // rendering the whole detail at once.
    for (let page = 0; page < 10; page += 1) {
      approval.handleInput("\x1b[C");
    }

    const lastPage = approval.render(40, 12).map(stripAnsi);

    expect(lastPage.length).toBeLessThanOrEqual(12);
    expect(lastPage).toContain("  // block line 40");
    expect(lastPage).not.toContain("  // block line 1");
    expect(lastPage).toContain("> Allow once");
    expect(lastPage).toContain("  Deny");
  });
});
