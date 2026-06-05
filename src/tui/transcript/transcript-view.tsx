import React from "react";
import { Box, Text } from "ink";
import type { LogLine } from "../types";

export const VISIBLE_LINE_LIMIT = 32;

export function TranscriptView({ lines }: { lines: LogLine[] }) {
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      justifyContent="flex-end"
      marginBottom={1}
      overflowY="hidden"
    >
      {lines.slice(-VISIBLE_LINE_LIMIT).map((line) => (
        <Text key={line.id} color={colorForTone(line.tone)}>
          {line.text}
        </Text>
      ))}
    </Box>
  );
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
