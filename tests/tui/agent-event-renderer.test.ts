import { describe, expect, spyOn, test } from "bun:test";
import type { AssistantMessage } from "../../src/core";
import { AgentEventRenderer } from "../../src/tui/app/agent-event-renderer";
import type { RunPhase } from "../../src/tui/app/status-phase";
import type { StatusLineState, Transcript } from "../../src/tui/components";
import { Transcript as TranscriptComponent } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Tui } from "../../src/tui/runtime";

describe("AgentEventRenderer", () => {
  test("catches up buffered text before showing a tool call", () => {
    const transcript = new TranscriptComponent();
    const renderer = new AgentEventRenderer({
      transcript,
      tui: {
        requestRender() {},
      } as unknown as Tui,
      updateStatus() {},
    });
    const text = "buffered assistant text ".repeat(8).trim();
    const textMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text }],
    };
    const toolCall = {
      type: "tool_call" as const,
      id: "call-buffered",
      name: "read",
      args: { path: "AGENTS.md" },
    };
    const toolMessage: AssistantMessage = {
      role: "assistant",
      content: [...textMessage.content, toolCall],
    };

    renderer.handle({ type: "message_start", message: { role: "assistant", content: [] } });
    renderer.handle({
      type: "message_update",
      message: textMessage,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: text,
        snapshot: textMessage,
      },
    });
    expect(stripAnsi(transcript.children[0]?.render(500).join("") ?? "")).not.toBe(text);

    renderer.handle({
      type: "message_update",
      message: toolMessage,
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 1,
        snapshot: toolMessage,
      },
    });

    expect(stripAnsi(transcript.children[0]?.render(500).join("") ?? "")).toBe(text);
    expect(transcript.children).toHaveLength(2);
    renderer.handle({ type: "agent_end", reason: "stop", messages: [] });
  });

  test("keeps parallel tools aggregated until all finish and retains error status", () => {
    const statuses: Array<{ phase: RunPhase; activeTool?: string }> = [];
    const renderer = new AgentEventRenderer({
      transcript: new TranscriptComponent() as Transcript,
      tui: {
        requestRender() {},
      } as unknown as Tui,
      updateStatus: (phase, extra: Partial<StatusLineState> = {}) => {
        statuses.push({
          phase,
          activeTool: extra.activeTool,
        });
      },
    });

    renderer.handle(toolStart("call-1", "read"));
    renderer.handle(toolStart("call-2", "read"));
    renderer.handle(toolStart("call-3", "grep"));

    expect(statuses.at(-1)).toEqual({
      phase: "tool",
      activeTool: "read +2",
    });

    renderer.handle(toolEnd("call-2", "read", true));

    expect(statuses.at(-1)).toEqual({
      phase: "error",
      activeTool: "read +1",
    });

    renderer.handle(toolEnd("call-1", "read", false));
    expect(statuses.at(-1)).toEqual({
      phase: "error",
      activeTool: "grep",
    });

    renderer.handle(toolEnd("call-3", "grep", false));
    expect(statuses.at(-1)).toEqual({
      phase: "error",
      activeTool: undefined,
    });

    renderer.handle({
      type: "agent_end",
      reason: "stop",
      messages: [],
    });
  });

  test("renders hosted web search as provider activity without a local tool block", () => {
    const transcript = new TranscriptComponent();
    const statuses: RunPhase[] = [];
    const renderer = new AgentEventRenderer({
      transcript,
      tui: {
        requestRender() {},
      } as unknown as Tui,
      updateStatus: (phase) => statuses.push(phase),
    });
    const searchingMessage: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "hosted_tool",
          id: "web-search-1",
          name: "web_search",
          status: "in_progress",
        },
      ],
    };

    renderer.handle({ type: "message_start", message: { role: "assistant", content: [] } });
    renderer.handle({
      type: "message_update",
      message: searchingMessage,
      assistantMessageEvent: {
        type: "hosted_tool_start",
        contentIndex: 0,
        snapshot: searchingMessage,
      },
    });

    expect(statuses.at(-1)).toBe("searching");
    expect(transcript.children).toHaveLength(1);
    expect(stripAnsi(transcript.render(100).join("\n"))).toContain("◆ Searching the web");

    renderer.handle({ type: "agent_end", reason: "stop", messages: [] });
  });

  test("stops an unfinished hosted tool timer when an aborted message settles", () => {
    let now = 0;
    const dateNow = spyOn(Date, "now").mockImplementation(() => now);
    const transcript = new TranscriptComponent();
    const renderer = new AgentEventRenderer({
      transcript,
      tui: {
        requestRender() {},
      } as unknown as Tui,
      updateStatus() {},
    });
    const searchingMessage: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "hosted_tool",
          id: "web-search-aborted",
          name: "web_search",
          status: "in_progress",
        },
      ],
    };

    try {
      renderer.handle({ type: "message_start", message: { role: "assistant", content: [] } });
      renderer.handle({
        type: "message_update",
        message: searchingMessage,
        assistantMessageEvent: {
          type: "hosted_tool_start",
          contentIndex: 0,
          snapshot: searchingMessage,
        },
      });

      now = 2_000;
      expect(stripAnsi(transcript.render(80)[0] ?? "")).toBe(
        "◆ Searching the web (2s) (Esc to abort)",
      );

      renderer.handle({
        type: "message_end",
        message: { ...searchingMessage, stopReason: "aborted" },
      });
      renderer.handle({ type: "agent_end", reason: "aborted", messages: [] });
      now = 7_000;

      expect(stripAnsi(transcript.render(80)[0] ?? "")).toBe("◆ Searching the web (2s)");
    } finally {
      renderer.handle({ type: "agent_end", reason: "aborted", messages: [] });
      dateNow.mockRestore();
    }
  });

  test("keeps one timer across adjacent thinking items until the next action", () => {
    let now = 0;
    const dateNow = spyOn(Date, "now").mockImplementation(() => now);
    const transcript = new TranscriptComponent();
    const renderer = new AgentEventRenderer({
      transcript,
      tui: {
        requestRender() {},
      } as unknown as Tui,
      updateStatus() {},
    });
    const firstThinking: AssistantMessage = {
      role: "assistant",
      content: [{ type: "thinking", text: "first" }],
    };
    const adjacentThinking: AssistantMessage = {
      role: "assistant",
      content: [...firstThinking.content, { type: "thinking", text: "second" }],
    };
    const toolCall = {
      type: "tool_call" as const,
      id: "call-after-thinking",
      name: "read",
      args: { path: "AGENTS.md" },
    };
    const toolMessage: AssistantMessage = {
      role: "assistant",
      content: [...adjacentThinking.content, toolCall],
    };

    try {
      renderer.handle({ type: "message_start", message: { role: "assistant", content: [] } });
      renderer.handle({
        type: "message_update",
        message: firstThinking,
        assistantMessageEvent: {
          type: "thinking_start",
          contentIndex: 0,
          snapshot: firstThinking,
        },
      });

      now = 2_000;
      renderer.handle({
        type: "message_update",
        message: firstThinking,
        assistantMessageEvent: {
          type: "thinking_end",
          contentIndex: 0,
          content: "first",
          snapshot: firstThinking,
        },
      });
      expect(stripAnsi(transcript.render(80)[0] ?? "")).toBe("thinking (2s) (Esc to abort)");

      now = 3_000;
      renderer.handle({
        type: "message_update",
        message: adjacentThinking,
        assistantMessageEvent: {
          type: "thinking_start",
          contentIndex: 1,
          snapshot: adjacentThinking,
        },
      });
      expect(stripAnsi(transcript.render(80)[0] ?? "")).toBe("thinking (3s) (Esc to abort)");

      renderer.handle({
        type: "message_update",
        message: toolMessage,
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 2,
          snapshot: toolMessage,
        },
      });
      expect(stripAnsi(transcript.children[0]?.render(80).join("\n") ?? "")).toBe("");
    } finally {
      renderer.handle({ type: "agent_end", reason: "stop", messages: [] });
      dateNow.mockRestore();
    }
  });
});

function toolStart(toolCallId: string, toolName: string) {
  return {
    type: "tool_execution_start" as const,
    toolCallId,
    toolName,
    args: {},
  };
}

function toolEnd(toolCallId: string, toolName: string, isError: boolean) {
  return {
    type: "tool_execution_end" as const,
    toolCallId,
    toolName,
    result: {},
    isError,
  };
}
