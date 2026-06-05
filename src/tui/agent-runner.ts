import React from "react";
import type { Agent } from "../agent";
import { handleAgentEvent } from "./agent-event-reducer";
import { appendLine } from "./transcript/transcript-state";
import type { LogLine, RunStatus } from "./types";

export type AgentPromptRun = {
  agent: Agent;
  prompt: string;
  nextId: React.MutableRefObject<number>;
  setLines: React.Dispatch<React.SetStateAction<LogLine[]>>;
  setStatus: React.Dispatch<React.SetStateAction<RunStatus>>;
};

export async function runAgentPrompt({
  agent,
  prompt,
  nextId,
  setLines,
  setStatus,
}: AgentPromptRun): Promise<void> {
  appendLine(nextId, setLines, "user", `> ${prompt}`);

  try {
    const stream = agent.stream(prompt);

    for await (const event of stream) {
      handleAgentEvent(event, nextId, setLines, setStatus);
    }

    await stream.result();
  } catch (error) {
    setStatus((current) => ({
      ...current,
      phase: "error",
      activeTool: undefined,
    }));
    appendLine(
      nextId,
      setLines,
      "error",
      error instanceof Error ? error.message : String(error),
    );
  }
}
