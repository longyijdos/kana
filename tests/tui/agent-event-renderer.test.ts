import { describe, expect, test } from "bun:test";
import { AgentEventRenderer } from "../../src/tui/app/agent-event-renderer";
import type { RunPhase } from "../../src/tui/app/status-phase";
import type { StatusLineState, Transcript } from "../../src/tui/components";
import { Transcript as TranscriptComponent } from "../../src/tui/components";
import type { Tui } from "../../src/tui/runtime";

describe("AgentEventRenderer", () => {
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
