import { describe, expect, test } from "bun:test";
import { createMessageIdentity, type Message } from "@/core";
import type { KanaSessionTimelineEntry } from "@/kana";
import { addHistoryTimelineToTranscript } from "../../src/tui/app/history";
import { ToolCallBlock, Transcript } from "../../src/tui/components";
import { color, stripAnsi } from "../../src/tui/render";
import { tuiTheme } from "../../src/tui/theme";
import { messageIdentityForTest } from "../helpers/messages";

describe("tui history transcript", () => {
  test("preserves LaTeX source in restored messages when rendering is disabled", () => {
    const transcript = new Transcript();

    addHistoryTimelineToTranscript(
      transcript,
      timelineFromMessages([
        {
          ...messageIdentityForTest("assistant"),
          role: "assistant",
          content: [{ type: "text", text: "Result $x^2$" }],
        },
      ]),
      { renderLatex: false },
    );

    expect(transcript.render(80).map(stripAnsi)).toEqual(["Result $x^2$"]);
  });

  test("preserves Mermaid source in restored messages when rendering is disabled", () => {
    const transcript = new Transcript();

    addHistoryTimelineToTranscript(
      transcript,
      timelineFromMessages([
        {
          ...messageIdentityForTest("assistant"),
          role: "assistant",
          content: [
            {
              type: "text",
              text: ["```mermaid", "flowchart LR", "  A --> B", "```"].join("\n"),
            },
          ],
        },
      ]),
      { renderMermaid: false },
    );

    expect(transcript.render(80).map(stripAnsi)).toEqual(["    flowchart LR", "      A --> B"]);
  });

  test("renders restored user, assistant, and tool messages", () => {
    const transcript = new Transcript();
    const messages: Message[] = [
      {
        ...messageIdentityForTest("user"),
        role: "user",
        content: "show package",
      },
      {
        ...messageIdentityForTest("assistant"),
        role: "assistant",
        stopReason: "toolUse",
        content: [
          {
            type: "thinking",
            text: "internal reasoning",
          },
          {
            type: "text",
            text: "I'll inspect it.",
          },
          {
            type: "tool_call",
            id: "call_1",
            name: "read",
            args: {
              path: "package.json",
            },
          },
        ],
      },
      {
        ...messageIdentityForTest("tool"),
        role: "tool",
        toolCallId: "call_1",
        toolName: "read",
        content: "file contents",
        result: {
          path: "package.json",
          content: '{\n  "private": true\n}',
          startLine: 1,
          endLine: 3,
          totalLines: 3,
          truncated: false,
        },
        isError: false,
      },
    ];

    addHistoryTimelineToTranscript(transcript, timelineFromMessages(messages));

    const lines = transcript.render(100).map(stripAnsi);

    expect(lines).toContain(
      "| > show package                                                                                   |",
    );
    expect(lines).toContain("I'll inspect it.");
    expect(lines.some((line) => line.includes("Working ("))).toBe(false);
    expect(lines).toContain("◆ Read");
    expect(lines).toContain("  └ package.json");
    expect(lines).toContain("package.json:1-3 of 3");
    expect(lines).not.toContain('  "private": true');
  });

  test("restores view_image results with their dedicated renderer", () => {
    const transcript = new Transcript();
    const messages: Message[] = [
      {
        ...messageIdentityForTest("assistant"),
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call-view",
            name: "view_image",
            args: { path: "artifacts/screenshot.png" },
          },
        ],
      },
      {
        ...messageIdentityForTest("tool"),
        role: "tool",
        toolCallId: "call-view",
        toolName: "view_image",
        content: "Viewed screenshot",
        images: [{ mimeType: "image/png", data: "aW1hZ2U=", width: 1440, height: 832 }],
        result: {
          path: "artifacts/screenshot.png",
          mimeType: "image/png",
          width: 1440,
          height: 832,
          byteSize: 19 * 1024,
        },
        isError: false,
      },
    ];

    addHistoryTimelineToTranscript(transcript, timelineFromMessages(messages));

    const lines = transcript.render(100).map(stripAnsi);
    expect(lines).toContain("◆ Viewed");
    expect(lines).toContain("  └ artifacts/screenshot.png");
    expect(lines).toContain("PNG · 1440×832 · 19 KB");
    expect(lines.join("\n")).not.toContain('"byteSize"');
  });

  test("renders artifact-backed restored results as compact metadata", () => {
    const transcript = new Transcript();
    const messages: Message[] = [
      {
        ...messageIdentityForTest("assistant"),
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call-artifact",
            name: "bash",
            args: { command: "generate lots of output" },
          },
        ],
      },
      {
        ...messageIdentityForTest("tool"),
        role: "tool",
        toolCallId: "call-artifact",
        toolName: "bash",
        content: "MODEL_FACING_ARTIFACT_PREVIEW_SHOULD_NOT_RENDER",
        artifact: {
          kind: "text",
          locator: "/tmp/kana-artifacts/session/large-output.txt",
          byteLength: 83 * 1_024,
        },
        isError: false,
      },
    ];

    addHistoryTimelineToTranscript(transcript, timelineFromMessages(messages));

    const rendered = transcript.render(100).map(stripAnsi).join("\n");
    expect(rendered).toContain("Output stored · 83 KB");
    expect(rendered).not.toContain("MODEL_FACING_ARTIFACT_PREVIEW_SHOULD_NOT_RENDER");
    expect(rendered).not.toContain("/tmp/kana-artifacts/session/large-output.txt");
  });

  test("uses distinct colors for user input and Markdown headings", () => {
    const transcript = new Transcript();

    addHistoryTimelineToTranscript(
      transcript,
      timelineFromMessages([
        {
          ...messageIdentityForTest("user"),
          role: "user",
          content: "Question",
        },
        {
          ...messageIdentityForTest("assistant"),
          role: "assistant",
          content: [{ type: "text", text: "# Answer" }],
        },
      ]),
    );

    const rendered = transcript.render(100);
    const userLine = rendered.find((line) => stripAnsi(line).includes("> Question")) ?? "";
    const headingLine = rendered.find((line) => stripAnsi(line) === "Answer") ?? "";

    expect(tuiTheme.user).not.toEqual(tuiTheme.markdownHeading);
    expect(userLine).toContain(`\x1b[38;2;${tuiTheme.user.join(";")}m> `);
    expect(userLine).not.toContain("\x1b[48;");
    expect(headingLine).toContain(color("Answer", tuiTheme.markdownHeading));
  });

  test("renders tool results even when the original tool call is missing", () => {
    const transcript = new Transcript();

    addHistoryTimelineToTranscript(
      transcript,
      timelineFromMessages([
        {
          ...messageIdentityForTest("tool"),
          role: "tool",
          toolCallId: "call_missing",
          toolName: "bash",
          content: "Tool call failed: no call",
          result: {
            error: "no call",
          },
          isError: true,
        },
      ]),
    );

    const lines = transcript.render(100).map(stripAnsi);

    expect(lines).toContain("◆ Failed to run");
    expect(lines).toContain("  └ bash");
    expect(lines).toContain("no call");
  });

  test("renders restored scheduled input consistently with a live wake", () => {
    const transcript = new Transcript();

    addHistoryTimelineToTranscript(
      transcript,
      timelineFromMessages([
        {
          ...messageIdentityForTest("user", "scheduled"),
          role: "user",
          content: "[Scheduled wake event]\nCheck the long-running task.",
        },
      ]),
    );

    expect(transcript.render(100).map(stripAnsi)).toContain(
      "Scheduled wake: Check the long-running task.",
    );
  });

  test("replays todo tool blocks from their durable accepted snapshots", () => {
    const transcript = new Transcript();
    const assistant = {
      ...messageIdentityForTest("assistant"),
      role: "assistant" as const,
      stopReason: "toolUse" as const,
      content: [
        {
          type: "tool_call" as const,
          id: "call-todo-history",
          name: "todo_write",
          args: {
            items: [{ content: "Untrusted proposed text", status: "pending" }],
          },
        },
      ],
    };
    const result = {
      ...messageIdentityForTest("tool"),
      role: "tool" as const,
      toolCallId: "call-todo-history",
      toolName: "todo_write",
      content: "Todo list updated.",
      result: { status: "updated" },
      isError: false,
    };
    const timeline: KanaSessionTimelineEntry[] = [
      {
        type: "message",
        id: "assistant-entry",
        parentId: null,
        timestamp: "2026-08-24T00:00:00.000Z",
        message: assistant,
      },
      {
        type: "todo_state",
        id: "todo-entry",
        parentId: "assistant-entry",
        timestamp: "2026-08-24T00:00:01.000Z",
        toolCallId: "call-todo-history",
        items: [
          { content: "Persist the accepted snapshot", status: "in_progress" },
          { content: "Replay it in the TUI", status: "completed" },
        ],
      },
      {
        type: "message",
        id: "result-entry",
        parentId: "todo-entry",
        timestamp: "2026-08-24T00:00:02.000Z",
        message: result,
      },
    ];

    addHistoryTimelineToTranscript(transcript, timeline);

    expect(transcript.render(100).map(stripAnsi)).toEqual([
      "◆ Updated todos",
      "  └ 1 active · 0 pending · 1 completed · Persist the accepted snapshot",
    ]);
    const block = transcript.children.find(
      (child): child is ToolCallBlock => child instanceof ToolCallBlock,
    );
    expect(block?.getToolDetailView().render(100).map(stripAnsi)).toContain(
      "◉ Persist the accepted snapshot",
    );
    expect(block?.getToolDetailView().render(100).map(stripAnsi).join("\n")).not.toContain(
      "Untrusted proposed text",
    );
  });

  test("hides internal context messages from restored transcripts", () => {
    const transcript = new Transcript();

    addHistoryTimelineToTranscript(
      transcript,
      timelineFromMessages([
        {
          ...createMessageIdentity({ kind: "runtime_context", source: "environment" }),
          role: "user",
          content: '<runtime_context source="environment">hidden</runtime_context>',
        },
        {
          ...createMessageIdentity({ kind: "tool_result_policy", source: "repeated_tool_call" }),
          role: "user",
          content: "hidden repeated-call reminder",
        },
        {
          ...messageIdentityForTest("user"),
          role: "user",
          content: "Visible question",
        },
      ]),
    );

    const rendered = transcript.render(100).map(stripAnsi).join("\n");
    expect(rendered).toContain("Visible question");
    expect(rendered).not.toContain("runtime_context");
    expect(rendered).not.toContain("hidden");
    expect(rendered).not.toContain("repeated-call reminder");
  });

  test("renders recovery input as a muted marker and ignores turn boundaries", () => {
    const transcript = new Transcript();
    const timeline: KanaSessionTimelineEntry[] = [
      {
        type: "turn_start",
        id: "start-1",
        parentId: null,
        timestamp: "2026-07-30T00:00:00.000Z",
        turnId: "turn-1",
        kind: "agent",
      },
      {
        type: "message",
        id: "recovery-1",
        parentId: "start-1",
        timestamp: "2026-07-30T00:00:01.000Z",
        message: {
          ...messageIdentityForTest("user", "recovery"),
          role: "user",
          content: "[Session recovery]\nThe previous agent run was interrupted.",
        },
      },
      {
        type: "turn_end",
        id: "end-1",
        parentId: "recovery-1",
        timestamp: "2026-07-30T00:00:02.000Z",
        turnId: "turn-1",
        outcome: "interrupted",
      },
    ];

    addHistoryTimelineToTranscript(transcript, timeline);

    const rendered = transcript.render(100);
    const marker =
      rendered.find((line) => stripAnsi(line).includes("recorded history was recovered")) ?? "";

    expect(stripAnsi(marker)).toBe(
      "Previous agent run was interrupted; recorded history was recovered safely.",
    );
    expect(marker).toContain(`\x1b[38;2;${tuiTheme.muted.join(";")}m`);
  });

  test("renders context compaction markers in timeline order", () => {
    const transcript = new Transcript();
    const [message] = timelineFromMessages([
      { ...messageIdentityForTest("user"), role: "user", content: "Before compact" },
    ]);

    expect(message).toBeDefined();
    addHistoryTimelineToTranscript(transcript, [
      message!,
      {
        type: "context_compaction",
        id: "compact-1",
        parentId: message!.id,
        timestamp: "2026-07-24T00:00:01.000Z",
        reason: "threshold",
        coversThroughId: message!.id,
        compactedMessageCount: 1,
        beforeTokens: 812_000,
        estimatedAfterTokens: 430_000,
        summary: {
          format: "kana-context-summary-v1",
          text: "Earlier context.",
        },
      },
    ]);

    const rendered = transcript.render(100);
    const marker = rendered.find((line) => stripAnsi(line).includes("Context compacted")) ?? "";

    expect(stripAnsi(marker)).toContain("Context compacted · 812k → ~430k tokens");
    expect(marker).toContain(`\x1b[38;2;${tuiTheme.muted.join(";")}m`);
  });
});

function timelineFromMessages(messages: Message[]): KanaSessionTimelineEntry[] {
  return messages.map((message, index) => ({
    type: "message",
    id: `message-${index + 1}`,
    parentId: index === 0 ? null : `message-${index}`,
    timestamp: "2026-07-24T00:00:00.000Z",
    message,
  }));
}
