import { describe, expect, test } from "bun:test";
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
