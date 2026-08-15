import { describe, expect, test } from "bun:test";
import type { Message } from "@/core";
import type { KanaSessionTimelineEntry } from "@/kana";
import { addHistoryTimelineToTranscript } from "../../src/tui/app/history";
import { Transcript } from "../../src/tui/components";
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
    expect(lines).not.toContain("thinking (Esc to abort)");
    expect(lines).toContain("◆ Read");
    expect(lines).toContain("  └ package.json");
    expect(lines).toContain("package.json:1-3 of 3");
    expect(lines).not.toContain('  "private": true');
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
