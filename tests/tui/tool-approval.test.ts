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

  test("renders MCP provenance and complete formatted arguments", () => {
    const approval = new ToolApproval(
      {
        type: "tool_call",
        id: "call_1",
        name: "github_create_issue",
        args: {
          owner: "kana",
          issue: { title: "Fix startup", labels: ["bug", "release-blocker"] },
          body: Array.from({ length: 5 }, (_, index) => `body line ${index + 1}`).join("\n"),
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
    expect(rendered).toContain("Server");
    expect(rendered).toContain("  github");
    expect(rendered).toContain("Tool");
    expect(rendered).toContain("  create_issue");
    expect(rendered).toContain("Arguments");
    // Complete nested arguments survive; long values rely on paging instead
    // of a pre-render summary.
    expect(detail).toContain('"owner": "kana"');
    expect(detail).toContain('"title": "Fix startup"');
    expect(detail).toContain('"labels": [');
    expect(detail).toContain('"release-blocker"');
    expect(detail).toContain("body line 5");
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

  test("keeps complete long write content in the approval detail without summarizing", () => {
    const content = Array.from(
      { length: 60 },
      (_, index) => `// generated line ${index + 1}: ${"payload-".repeat(12)}${index + 1}`,
    ).join("\n");
    const approval = new ToolApproval(
      {
        type: "tool_call",
        id: "call_1",
        name: "write",
        args: { path: "src/generated.ts", content },
      },
      () => {},
    );

    // Wide viewport avoids wrapping so the complete source lines stay contiguous.
    const rendered = approval.render(400).map(stripAnsi);
    const detail = rendered.join("\n");

    expect(rendered).toContain("Path");
    expect(rendered).toContain("  src/generated.ts");
    expect(rendered).toContain("Content");
    // First and last source lines survive; summarizeText() would collapse
    // whitespace and drop everything after 77 characters.
    expect(detail).toContain("  // generated line 1: ");
    expect(detail).toContain("  // generated line 60: ");
    expect(detail).not.toContain("...");
  });

  test("keeps complete oldText, newText, and replaceAll information for edit approvals", () => {
    const oldText = Array.from({ length: 5 }, (_, index) => `old line ${index + 1}`).join("\n");
    const newText = Array.from({ length: 5 }, (_, index) => `new line ${index + 1}`).join("\n");
    const approval = new ToolApproval(
      {
        type: "tool_call",
        id: "call_1",
        name: "edit",
        args: { path: "src/app.ts", oldText, newText, replaceAll: true },
      },
      () => {},
    );

    const rendered = approval.render(80).map(stripAnsi);

    expect(rendered).toContain("Allow agent to edit file?");
    expect(rendered).toContain("Path");
    expect(rendered).toContain("  src/app.ts");
    expect(rendered).toContain("Replace");
    expect(rendered).toContain("  old line 1");
    expect(rendered).toContain("  old line 5");
    expect(rendered).toContain("With");
    expect(rendered).toContain("  new line 1");
    expect(rendered).toContain("  new line 5");
    expect(rendered).toContain("Replace all");
    expect(rendered).toContain("  every occurrence in the file");
  });

  test("keeps the complete bash command together with cwd and timeout", () => {
    const command = `echo "${"x".repeat(300)}"`;
    const approval = new ToolApproval(
      {
        type: "tool_call",
        id: "call_1",
        name: "bash",
        args: {
          command,
          cwd: "deeply/nested/working/directory",
          timeoutMs: 120_000,
        },
      },
      () => {},
    );

    const rendered = approval.render(400).map(stripAnsi);

    expect(rendered).toContain("Command");
    expect(rendered).toContain(`  ${command}`);
    expect(rendered).toContain("Working directory");
    expect(rendered).toContain("  deeply/nested/working/directory");
    expect(rendered).toContain("Timeout");
    expect(rendered).toContain("  120000 ms");
  });

  test("keeps complete arguments for custom tools without guessing a target", () => {
    const args = {
      target: "element-ref",
      command: `run-${"long-".repeat(40)}`,
      nested: { items: Array.from({ length: 10 }, (_, index) => `entry-${index}`) },
    };
    const approval = new ToolApproval(
      {
        type: "tool_call",
        id: "call_1",
        name: "custom_lookup",
        args,
      },
      () => {},
    );

    // Wide viewport avoids wrapping so the complete argument values stay
    // contiguous in the rendered JSON.
    const rendered = approval.render(400).map(stripAnsi);
    const detail = rendered.join("\n");

    expect(rendered).toContain("Allow agent to use custom_lookup?");
    expect(rendered).toContain("Tool");
    expect(rendered).toContain("  custom_lookup");
    expect(rendered).toContain("Arguments");
    // The raw "target" argument stays inside the complete JSON instead of
    // being promoted to a guessed target row.
    expect(detail).toContain('"target": "element-ref"');
    expect(detail).toContain(`"command": "run-${"long-".repeat(40)}"`);
    expect(detail).toContain('"entry-9"');
    expect(rendered).not.toContain("└");
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

  test("sanitizes a malicious custom tool name in the approval title and Tool section", () => {
    const toolCall = {
      type: "tool_call" as const,
      id: "call_1",
      name: "evil\u001b]0;owned\u0007tool\nname\u001f",
      args: { value: "safe\u001b[31mred\u001b[0m" },
    };

    const text = formatToolApproval(toolCall);

    // The single-row approval title carries the sanitized identity only.
    expect(text.title).toBe("Allow agent to use eviltool name?");
    expect(text.title).not.toContain("\u001b");
    expect(text.title).not.toContain("\u0007");
    expect(text.title).not.toContain("\u001f");
    expect(text.title).not.toContain("\n");

    // The Tool section mirrors the sanitized identity, and the complete
    // arguments stay sanitized as well.
    expect(text.detail).toContain("Tool\n  eviltool name");
    expect(text.detail).not.toContain("\u001b");
    expect(text.detail).not.toContain("\u0007");
    expect(text.detail).not.toContain("\u0000");
    expect(text.detail).not.toContain("\u001f");
    expect(text.detail).toContain('"value": "safered"');

    const approval = new ToolApproval(toolCall, () => {});
    const rendered = approval.render(80).map(stripAnsi);

    expect(rendered).toContain("Allow agent to use eviltool name?");
    expect(rendered).toContain("  eviltool name");
    expect(rendered.join("\n")).toContain('"value": "safered"');
  });

  test("sanitizes terminal control sequences in MCP provenance and arguments", () => {
    const toolCall = {
      type: "tool_call" as const,
      id: "call_1",
      name: "mcp_inject",
      args: {
        title: "safe\u001b]0;evil\u0007prefix",
        nested: ["\u001b[31mred\u001b[0m", "plain\u0000ctl"],
      },
    };

    const detail = formatToolApproval(toolCall, {
      kind: "mcp",
      serverId: "evil\nserver",
      remoteToolName: "inject\u001b[31m",
    }).detail;

    expect(detail).toContain("evil server");
    expect(detail).toContain("inject");
    expect(detail).toContain("safeprefix");
    expect(detail).toContain("plainctl");
    expect(detail).not.toContain("\u001b");
    expect(detail).not.toContain("\u0000");
    expect(detail).not.toContain("\u001f");
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
