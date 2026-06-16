import { describe, expect, test } from "bun:test";
import type { Message } from "@/core";
import { addHistoryMessagesToTranscript } from "../src/tui/app/history";
import { Transcript } from "../src/tui/components";
import { stripAnsi } from "../src/tui/render";

describe("tui history transcript", () => {
  test("renders restored user, assistant, and tool messages", () => {
    const transcript = new Transcript();
    const messages: Message[] = [
      {
        role: "user",
        content: "show package",
      },
      {
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

    addHistoryMessagesToTranscript(transcript, messages);

    const lines = transcript.render(100).map(stripAnsi);

    expect(lines).toContain("> show package");
    expect(lines).toContain("I'll inspect it.");
    expect(lines).not.toContain("thinking...");
    expect(lines).toContain("Read package.json");
    expect(lines).toContain("{");
    expect(lines).toContain('  "private": true');
  });

  test("renders tool results even when the original tool call is missing", () => {
    const transcript = new Transcript();

    addHistoryMessagesToTranscript(transcript, [
      {
        role: "tool",
        toolCallId: "call_missing",
        toolName: "bash",
        content: "Tool call failed: no call",
        result: {
          error: "no call",
        },
        isError: true,
      },
    ]);

    const lines = transcript.render(100).map(stripAnsi);

    expect(lines).toContain("Failed to run bash");
    expect(lines).toContain("no call");
  });
});
