import React from "react";
import { Box, useCursor } from "ink";
import type { RunStatus } from "../types";
import { StatusLine } from "../status/status-line";
import { CommandPalette } from "./command-palette";
import { createInputLayout } from "./input-layout";
import { PromptInput } from "./prompt-input";
import type { PromptSubmit } from "./commands";
import { usePromptEditor } from "./use-prompt-editor";

const MAX_INPUT_LINES = 3;
const INPUT_FRAME_ROWS = 2;
const INPUT_FRAME_COLUMNS = 4;
const PROMPT_COLUMNS = 2;
const INPUT_TEXT_START_COLUMN = 4;
const INPUT_TEXT_START_ROW = 1;
// Ink positions the cursor from the line after normal output. Exact-fullscreen
// alternate-screen frames do not have that extra line, so compensate here.
const CURSOR_FULLSCREEN_ROW_OFFSET = 1;

export function PromptComposer({
  columns,
  rows,
  value,
  status,
  model,
  isRunning,
  onChange,
  onSubmit,
}: {
  columns: number;
  rows: number;
  value: string;
  status: RunStatus;
  model: string;
  isRunning: boolean;
  onChange(value: string): void;
  onSubmit(submit: PromptSubmit): void;
}) {
  const { setCursorPosition } = useCursor();
  const editor = usePromptEditor({
    value,
    onChange,
    onSubmit,
  });
  const supportHeight = editor.commandState.showPalette
    ? Math.max(editor.commandState.suggestions.length, 1)
    : 1;
  const maxInputLines = Math.max(
    1,
    Math.min(MAX_INPUT_LINES, rows - supportHeight - INPUT_FRAME_ROWS),
  );
  const inputColumns = Math.max(
    columns - INPUT_FRAME_COLUMNS - PROMPT_COLUMNS,
    1,
  );
  const inputLayout = createInputLayout({
    value,
    cursorOffset: editor.cursorOffset,
    columns: inputColumns,
    maxLines: maxInputLines,
  });
  const inputHeight = inputLayout.lines.length + INPUT_FRAME_ROWS;
  const composerHeight = inputHeight + supportHeight;
  const composerTop = Math.max(rows - composerHeight, 0);
  const cursorX = Math.min(
    INPUT_TEXT_START_COLUMN + inputLayout.cursor.column,
    Math.max(columns - 2, 0),
  );
  const cursorY = Math.min(
    composerTop +
      INPUT_TEXT_START_ROW +
      inputLayout.cursor.line +
      CURSOR_FULLSCREEN_ROW_OFFSET,
    Math.max(rows - 1, 0),
  );

  setCursorPosition({
    x: cursorX,
    y: cursorY,
  });

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      height={composerHeight}
      overflow="hidden"
      width={columns}
    >
      <PromptInput
        columns={columns}
        cursorOffset={editor.cursorOffset}
        layout={inputLayout}
        value={value}
      />

      <Box height={supportHeight} overflow="hidden" width={columns}>
        {editor.commandState.showPalette ? (
          <CommandPalette
            commands={editor.commandState.suggestions}
            selectedIndex={editor.selectedCommandIndex}
          />
        ) : (
          <StatusLine status={status} model={model} isRunning={isRunning} />
        )}
      </Box>
    </Box>
  );
}
