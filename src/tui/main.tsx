import React, { useRef, useState } from "react";
import { Box, render, useApp, useInput } from "ink";
import type { Agent } from "../agent";
import { createKanaAgent } from "../kana/agent";
import { handleAgentEvent } from "./event-handlers";
import { PromptArea } from "./prompt/area";
import type { PromptSubmit } from "./prompt/commands";
import { appendLine, Transcript } from "./transcript";
import type { LogLine, RunStatus } from "./types";

export type StartTuiOptions = {
  apiKey?: string;
};

export function startTui(options: StartTuiOptions = {}): void {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    throw new Error(
      "Missing DEEPSEEK_API_KEY. Run with: DEEPSEEK_API_KEY=... ./kana",
    );
  }

  render(<App agent={createKanaAgent(apiKey)} />);
}

function App({ agent }: { agent: Agent }) {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState<RunStatus>({
    phase: "idle",
    maxTurns: agent.state.maxTurns,
  });
  const [lines, setLines] = useState<LogLine[]>([
    {
      id: 0,
      tone: "muted",
      text: "Kana TUI. Type a prompt and press Enter.",
    },
    {
      id: 1,
      tone: "muted",
      text: "Try: Read package.json and summarize the project scripts.",
    },
  ]);
  const nextId = useRef(2);

  useInput((input, key) => {
    if (!key.escape || !isRunning) {
      return;
    }

    agent.abort();
    setStatus((current) => ({
      ...current,
      phase: "aborted",
      activeTool: undefined,
    }));
  });

  function handlePromptSubmit(submit: PromptSubmit): void {
    switch (submit.type) {
      case "message":
        void handleMessageSubmit(submit.content);
        break;
      case "command":
        handleCommandSubmit(submit);
        break;
    }
  }

  function handleCommandSubmit(submit: Extract<PromptSubmit, { type: "command" }>): void {
    switch (submit.name) {
      case "quit":
        exit();
        break;
    }
  }

  async function handleMessageSubmit(value: string): Promise<void> {
    const prompt = value.trim();

    if (!prompt || isRunning) {
      return;
    }

    setInput("");
    setIsRunning(true);
    setStatus({
      phase: "starting",
      maxTurns: agent.state.maxTurns,
    });
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
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <Box flexDirection="column">
      <Transcript lines={lines} />

      <PromptArea
        value={input}
        status={status}
        model={process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro"}
        isRunning={isRunning}
        onChange={setInput}
        onSubmit={handlePromptSubmit}
      />
    </Box>
  );
}
