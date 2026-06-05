import React from "react";
import { Box, Text } from "ink";
import { getCommandSpan } from "./commands";
import type { InputLayout, InputLayoutLine } from "./input-layout";

const PROMPT = "> ";
const CONTINUATION_PROMPT = "  ";
const PLACEHOLDER = "Ask the agent...";

export function PromptInput({
  columns,
  cursorOffset,
  layout,
  value,
}: {
  columns: number;
  cursorOffset: number;
  layout: InputLayout;
  value: string;
}) {
  const commandSpan = getCommandSpan(value);

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      flexDirection="column"
      height={layout.lines.length + 2}
      paddingX={1}
      width={columns}
    >
      {layout.lines.map((line, index) => (
        <Text key={`${line.startOffset}:${index}`} wrap="truncate-end">
          <Text color="yellow">
            {index === 0 ? PROMPT : CONTINUATION_PROMPT}
          </Text>
          {value ? (
            <PromptInputText
              cursorOffset={cursorOffset}
              line={line}
              commandSpan={commandSpan}
            />
          ) : index === 0 ? (
            <PromptPlaceholder />
          ) : null}
        </Text>
      ))}
    </Box>
  );
}

function PromptInputText({
  cursorOffset,
  line,
  commandSpan,
}: {
  cursorOffset: number;
  line: InputLayoutLine;
  commandSpan: { start: number; end: number } | undefined;
}) {
  if (cursorOffset < line.startOffset || cursorOffset > line.endOffset) {
    return <PromptInputRange commandSpan={commandSpan} line={line} />;
  }

  const relativeOffset = cursorOffset - line.startOffset;
  const textAfterCursor = line.text.slice(relativeOffset);
  const cursorText = firstGrapheme(textAfterCursor) ?? " ";
  const cursorEndOffset =
    cursorText === " " && textAfterCursor.length === 0
      ? cursorOffset
      : cursorOffset + cursorText.length;

  return (
    <Text>
      <PromptInputRange
        commandSpan={commandSpan}
        line={{
          ...line,
          text: line.text.slice(0, relativeOffset),
          endOffset: cursorOffset,
        }}
      />
      <PromptInputRange
        commandSpan={commandSpan}
        inverse
        line={{
          text: cursorText,
          startOffset: cursorOffset,
          endOffset: cursorEndOffset,
          width: 1,
        }}
      />
      <PromptInputRange
        commandSpan={commandSpan}
        line={{
          ...line,
          text: line.text.slice(relativeOffset + cursorText.length),
          startOffset: cursorEndOffset,
        }}
      />
    </Text>
  );
}

function PromptPlaceholder() {
  return (
    <Text>
      <Text inverse color="gray"> </Text>
      <Text color="gray">{PLACEHOLDER}</Text>
    </Text>
  );
}

function PromptInputRange({
  commandSpan,
  inverse = false,
  line,
}: {
  commandSpan: { start: number; end: number } | undefined;
  inverse?: boolean;
  line: InputLayoutLine;
}) {
  if (!line.text) {
    return null;
  }

  if (!commandSpan) {
    return (
      <Text color="white" inverse={inverse}>
        {line.text}
      </Text>
    );
  }

  const start = Math.max(commandSpan.start, line.startOffset);
  const end = Math.min(commandSpan.end, line.endOffset);

  if (start >= end) {
    return (
      <Text color="white" inverse={inverse}>
        {line.text}
      </Text>
    );
  }

  return (
    <Text>
      <Text color="white" inverse={inverse}>
        {line.text.slice(0, start - line.startOffset)}
      </Text>
      <Text color="yellow" inverse={inverse}>
        {line.text.slice(start - line.startOffset, end - line.startOffset)}
      </Text>
      <Text color="white" inverse={inverse}>
        {line.text.slice(end - line.startOffset)}
      </Text>
    </Text>
  );
}

function firstGrapheme(value: string): string | undefined {
  const segmenter = getSegmenter();

  if (segmenter) {
    return segmenter.segment(value)[Symbol.iterator]().next().value?.segment;
  }

  return Array.from(value)[0];
}

function getSegmenter():
  | {
      segment(value: string): Iterable<{ segment: string }>;
    }
  | undefined {
  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locale: string,
        options: { granularity: "grapheme" },
      ) => {
        segment(value: string): Iterable<{ segment: string }>;
      };
    }
  ).Segmenter;

  return Segmenter
    ? new Segmenter("en", {
        granularity: "grapheme",
      })
    : undefined;
}
