import React, { useRef, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { Agent, AgentEvent } from "../agent";
import type { AssistantMessageEvent } from "../core/events";
import type { AssistantStopReason } from "../core/messages";
import { createDemoAgent, DEFAULT_DEMO_PROMPT } from "../demo/agent";

type LogLine = {
  id: number;
  tone: "muted" | "user" | "assistant" | "thinking" | "tool" | "error";
  text: string;
};

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

  // Ctrl+C is handled by App so a running request can be aborted before the
  // TUI exits.
  render(<App agent={createDemoAgent(apiKey)} />, {
    exitOnCtrlC: false,
  });
}

function App({ agent }: { agent: Agent }) {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [lines, setLines] = useState<LogLine[]>([
    {
      id: 0,
      tone: "muted",
      text: "Kana TUI. Type a prompt and press Enter. Ctrl+C exits, or aborts a running request.",
    },
    {
      id: 1,
      tone: "muted",
      text: `Try: ${DEFAULT_DEMO_PROMPT.replace(/\n/g, " ")}`,
    },
  ]);
  const nextId = useRef(2);

  useInput((input, key) => {
    if (!(key.ctrl && input === "c")) {
      return;
    }

    if (isRunning) {
      agent.abort();
      appendLine(nextId, setLines, "muted", "Abort requested.");
      return;
    }

    exit();
  });

  async function handleSubmit(value: string): Promise<void> {
    const prompt = value.trim();

    if (!prompt || isRunning) {
      return;
    }

    setInput("");
    setIsRunning(true);
    setStatus("Running");
    appendLine(nextId, setLines, "user", `> ${prompt}`);

    try {
      const stream = agent.stream(prompt);

      for await (const event of stream) {
        handleAgentEvent(event, nextId, setLines, setStatus);
      }

      await stream.result();
    } catch (error) {
      setStatus("Error");
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
      <Box marginBottom={1}>
        <Text bold>Kana</Text>
        <Text color="gray">  {status}</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {lines.slice(-30).map((line) => (
          <Text key={line.id} color={colorForTone(line.tone)}>
            {line.text}
          </Text>
        ))}
      </Box>

      <Box>
        <Text color={isRunning ? "gray" : "green"}>
          {isRunning ? "running" : "prompt"}{" "}
        </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={(value) => {
            void handleSubmit(value);
          }}
          placeholder="Ask the agent..."
        />
      </Box>
    </Box>
  );
}

function handleAgentEvent(
  event: AgentEvent,
  nextId: React.MutableRefObject<number>,
  setLines: React.Dispatch<React.SetStateAction<LogLine[]>>,
  setStatus: React.Dispatch<React.SetStateAction<string>>,
): void {
  switch (event.type) {
    case "agent_start":
      setStatus("Agent started");
      break;
    case "agent_end":
      setStatus(statusForStopReason(lastAssistantStopReason(event.messages)));
      break;
    case "turn_start":
      appendLine(nextId, setLines, "muted", `turn ${event.turn} started`);
      break;
    case "turn_end":
      appendLine(
        nextId,
        setLines,
        "muted",
        `turn ${event.turn} ended, tool results: ${event.toolResults.length}`,
      );
      break;
    case "message_start":
      appendLine(nextId, setLines, "assistant", "assistant:");
      break;
    case "message_update":
      handleAssistantEvent(event.assistantMessageEvent, nextId, setLines);
      break;
    case "message_end":
      setStatus(statusForStopReason(event.message.stopReason));
      appendLine(
        nextId,
        setLines,
        toneForStopReason(event.message.stopReason),
        `assistant message ended: ${event.message.stopReason ?? "unknown"}`,
      );
      break;
    case "tool_execution_start":
      appendLine(
        nextId,
        setLines,
        "tool",
        `tool start ${event.toolName} ${JSON.stringify(event.args)}`,
      );
      break;
    case "tool_execution_update":
      appendLine(
        nextId,
        setLines,
        "tool",
        `tool update ${event.toolName} ${JSON.stringify(event.partialResult)}`,
      );
      break;
    case "tool_execution_end":
      appendLine(
        nextId,
        setLines,
        event.isError ? "error" : "tool",
        `tool end ${event.toolName} error=${event.isError} ${JSON.stringify(event.result)}`,
      );
      break;
  }
}

function lastAssistantStopReason(
  messages: Extract<AgentEvent, { type: "agent_end" }>["messages"],
): AssistantStopReason | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.role === "assistant") {
      return message.stopReason;
    }
  }

  return undefined;
}

function statusForStopReason(reason: AssistantStopReason | undefined): string {
  switch (reason) {
    case "stop":
      return "Done";
    case "toolUse":
      return "Tool requested";
    case "length":
      return "Length limit";
    case "aborted":
      return "Aborted";
    case "error":
      return "Error";
    case undefined:
      return "Unknown stop";
  }
}

function toneForStopReason(
  reason: AssistantStopReason | undefined,
): LogLine["tone"] {
  switch (reason) {
    case "aborted":
    case "error":
      return "error";
    case "toolUse":
      return "tool";
    case "stop":
    case "length":
    case undefined:
      return "muted";
  }
}

function handleAssistantEvent(
  event: AssistantMessageEvent,
  nextId: React.MutableRefObject<number>,
  setLines: React.Dispatch<React.SetStateAction<LogLine[]>>,
): void {
  switch (event.type) {
    case "thinking_start":
      appendLine(nextId, setLines, "thinking", "thinking: ");
      break;
    case "thinking_delta":
      appendToLastLine(setLines, "thinking", event.delta);
      break;
    case "text_start":
      appendLine(nextId, setLines, "assistant", "answer: ");
      break;
    case "text_delta":
      appendToLastLine(setLines, "assistant", event.delta);
      break;
    case "toolcall_start":
      appendLine(nextId, setLines, "tool", `tool call ${event.contentIndex}: `);
      break;
    case "toolcall_delta":
      appendToLastLine(setLines, "tool", event.delta);
      break;
    case "toolcall_end":
      appendLine(nextId, setLines, "tool", `tool call ended: ${event.toolCall.name}`);
      break;
    case "thinking_end":
    case "text_end":
    case "start":
    case "done":
    case "error":
      break;
  }
}

function appendLine(
  nextId: React.MutableRefObject<number>,
  setLines: React.Dispatch<React.SetStateAction<LogLine[]>>,
  tone: LogLine["tone"],
  text: string,
): void {
  setLines((current) => [
    ...current,
    {
      id: nextId.current++,
      tone,
      text,
    },
  ]);
}

function appendToLastLine(
  setLines: React.Dispatch<React.SetStateAction<LogLine[]>>,
  tone: LogLine["tone"],
  delta: string,
): void {
  setLines((current) => {
    const last = current.at(-1);

    if (!last || last.tone !== tone) {
      return current;
    }

    return [
      ...current.slice(0, -1),
      {
        ...last,
        text: last.text + delta,
      },
    ];
  });
}

function colorForTone(tone: LogLine["tone"]) {
  switch (tone) {
    case "user":
      return "cyan";
    case "assistant":
      return "green";
    case "thinking":
      return "gray";
    case "tool":
      return "yellow";
    case "error":
      return "red";
    case "muted":
      return "gray";
  }
}
