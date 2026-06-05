import React, { useRef } from "react";
import { Box, Text, useBoxMetrics, useCursor } from "ink";
import TextInput from "ink-text-input";
import stringWidth from "string-width";
import type { DOMElement } from "ink";

const INPUT_OFFSET_X = 4;
const INPUT_OFFSET_Y = 1;

export function PromptInput({
  value,
  isRunning,
  onChange,
  onSubmit,
}: {
  value: string;
  isRunning: boolean;
  onChange(value: string): void;
  onSubmit(value: string): void;
}) {
  const inputBoxRef = useRef<DOMElement>(null);
  const { left, top, hasMeasured } = useBoxMetrics(inputBoxRef);
  const { setCursorPosition } = useCursor();

  setCursorPosition(
    hasMeasured
      ? {
          x: left + INPUT_OFFSET_X + stringWidth(value),
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
      <Text color="white">
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder="Ask the agent..."
        />
      </Text>
    </Box>
  );
}
