import React from "react";
import { Box, Text } from "ink";
import type { LogLine } from "./types";

export const VISIBLE_LINE_LIMIT = 32;

export function Transcript({ lines }: { lines: LogLine[] }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {lines.slice(-VISIBLE_LINE_LIMIT).map((line) => (
        <Text key={line.id} color={colorForTone(line.tone)}>
          {line.text}
        </Text>
      ))}
    </Box>
  );
}

export function appendLine(
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

export function appendToLastLine(
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
