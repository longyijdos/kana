import React, { useRef, useState } from "react";
import { Box, useApp, useInput, useWindowSize } from "ink";
import type { Agent } from "../agent";
import { runAgentPrompt } from "./agent-runner";
import { PromptComposer } from "./prompt/composer";
import type { PromptSubmit } from "./prompt/commands";
import { TranscriptView } from "./transcript/transcript-view";
import type { LogLine, RunStatus } from "./types";

export function App({ agent }: { agent: Agent }) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
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

    try {
      await runAgentPrompt({
        agent,
        prompt,
        nextId,
        setLines,
        setStatus,
      });
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <Box flexDirection="column" height={rows} overflow="hidden" width={columns}>
      <TranscriptView lines={lines} />

      <PromptComposer
        columns={columns}
        rows={rows}
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
