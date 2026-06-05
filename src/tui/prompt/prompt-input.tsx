import React, { useRef } from "react";
import { Box, Text, useBoxMetrics, useCursor } from "ink";
import stringWidth from "string-width";
import type { DOMElement } from "ink";
import { getCommandSpan } from "./commands";

const INPUT_OFFSET_X = 4;
const INPUT_OFFSET_Y = 1;

export function PromptInput({
  value,
  cursorOffset,
  isRunning,
}: {
  value: string;
  cursorOffset: number;
  isRunning: boolean;
}) {
  const inputBoxRef = useRef<DOMElement>(null);
  const { left, top, hasMeasured } = useBoxMetrics(inputBoxRef);
  const { setCursorPosition } = useCursor();
  const textBeforeCursor = value.slice(0, cursorOffset);
  const commandSpan = getCommandSpan(value);

  setCursorPosition(
    hasMeasured
      ? {
          x: left + INPUT_OFFSET_X + stringWidth(textBeforeCursor),
          y: top + INPUT_OFFSET_Y,
        }
      : undefined,
  );

  return (
    <Box
      ref={inputBoxRef}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
    >
      <Text color={isRunning ? "gray" : "yellow"}>{"> "}</Text>
      {value ? (
        <PromptInputText value={value} commandSpan={commandSpan} />
      ) : (
        <Text color="gray">Ask the agent...</Text>
      )}
    </Box>
  );
}

function PromptInputText({
  value,
  commandSpan,
}: {
  value: string;
  commandSpan: { start: number; end: number } | undefined;
}) {
  if (!commandSpan) {
    return <Text color="white">{value}</Text>;
  }

  return (
    <Text>
      <Text color="yellow">{value.slice(commandSpan.start, commandSpan.end)}</Text>
      <Text color="white">{value.slice(commandSpan.end)}</Text>
    </Text>
  );
}
