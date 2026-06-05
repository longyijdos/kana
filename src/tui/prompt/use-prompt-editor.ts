import { useEffect, useState } from "react";
import { useInput } from "ink";
import {
  completeCommand,
  createCommandSubmit,
  getCommandState,
  type CommandState,
  type PromptSubmit,
} from "./commands";

export type PromptTextState = {
  value: string;
  cursorOffset: number;
};

export type PromptEditorState = PromptTextState & {
  commandState: CommandState;
  selectedCommandIndex: number;
};

export type PromptEditorAction =
  | {
      type: "insert";
      text: string;
    }
  | {
      type: "moveLeft";
    }
  | {
      type: "moveRight";
    }
  | {
      type: "moveStart";
    }
  | {
      type: "moveEnd";
    }
  | {
      type: "deleteBefore";
    }
  | {
      type: "deleteAfter";
    };

export type PromptEditorConfig = {
  value: string;
  onChange(value: string): void;
  onSubmit(submit: PromptSubmit): void;
};

export function usePromptEditor({
  value,
  onChange,
  onSubmit,
}: PromptEditorConfig): PromptEditorState {
  const [cursorOffset, setCursorOffset] = useState(value.length);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const commandState = getCommandState(value);
  const selectedCommand = commandState.suggestions[selectedCommandIndex];

  useEffect(() => {
    setCursorOffset((current) => clampToBoundary(value, current));
  }, [value]);

  useEffect(() => {
    setSelectedCommandIndex(0);
  }, [commandState.query]);

  useEffect(() => {
    setSelectedCommandIndex((current) =>
      Math.min(current, Math.max(commandState.suggestions.length - 1, 0)),
    );
  }, [commandState.suggestions.length]);

  useInput((input, key) => {
    if (key.ctrl || key.meta) {
      return;
    }

    if (key.return) {
      const submit = createCommandSubmit(value, selectedCommand);

      if (submit) {
        onSubmit(submit);
      }

      return;
    }

    if (key.leftArrow) {
      applyAction({
        type: "moveLeft",
      });
      return;
    }

    if (key.rightArrow) {
      applyAction({
        type: "moveRight",
      });
      return;
    }

    if (key.home) {
      applyAction({
        type: "moveStart",
      });
      return;
    }

    if (key.end) {
      applyAction({
        type: "moveEnd",
      });
      return;
    }

    if (key.backspace) {
      applyAction({
        type: "deleteBefore",
      });
      return;
    }

    if (key.delete) {
      applyAction({
        type: "deleteAfter",
      });
      return;
    }

    if (key.upArrow || key.downArrow) {
      if (commandState.isCommandMode && commandState.suggestions.length > 0) {
        setSelectedCommandIndex((current) =>
          key.upArrow
            ? wrapIndex(current - 1, commandState.suggestions.length)
            : wrapIndex(current + 1, commandState.suggestions.length),
        );
      }

      return;
    }

    if (key.tab) {
      if (commandState.isCommandMode && selectedCommand) {
        const completed = completeCommand(selectedCommand);

        onChange(completed);
        setCursorOffset(completed.length);
      }

      return;
    }

    if (key.pageUp || key.pageDown) {
      return;
    }

    if (!input) {
      return;
    }

    applyAction({
      type: "insert",
      text: input,
    });
  });

  return {
    value,
    cursorOffset,
    commandState,
    selectedCommandIndex,
  };

  function applyAction(action: PromptEditorAction): void {
    const nextState = applyPromptEditorAction(
      {
        value,
        cursorOffset,
      },
      action,
    );

    if (nextState.value !== value) {
      onChange(nextState.value);
    }

    setCursorOffset(nextState.cursorOffset);
  }
}

function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

export function applyPromptEditorAction(
  state: PromptTextState,
  action: PromptEditorAction,
): PromptTextState {
  const cursorOffset = clampToBoundary(state.value, state.cursorOffset);

  switch (action.type) {
    case "insert":
      return {
        value:
          state.value.slice(0, cursorOffset) +
          action.text +
          state.value.slice(cursorOffset),
        cursorOffset: cursorOffset + action.text.length,
      };
    case "moveLeft":
      return {
        value: state.value,
        cursorOffset: previousBoundary(state.value, cursorOffset),
      };
    case "moveRight":
      return {
        value: state.value,
        cursorOffset: nextBoundary(state.value, cursorOffset),
      };
    case "moveStart":
      return {
        value: state.value,
        cursorOffset: 0,
      };
    case "moveEnd":
      return {
        value: state.value,
        cursorOffset: state.value.length,
      };
    case "deleteBefore": {
      const start = previousBoundary(state.value, cursorOffset);

      return {
        value: state.value.slice(0, start) + state.value.slice(cursorOffset),
        cursorOffset: start,
      };
    }
    case "deleteAfter": {
      const end = nextBoundary(state.value, cursorOffset);

      return {
        value: state.value.slice(0, cursorOffset) + state.value.slice(end),
        cursorOffset,
      };
    }
  }
}

function clampToBoundary(value: string, offset: number): number {
  if (offset <= 0) {
    return 0;
  }

  if (offset >= value.length) {
    return value.length;
  }

  const boundaries = graphemeBoundaries(value);
  let closest = 0;

  for (const boundary of boundaries) {
    if (boundary > offset) {
      return closest;
    }

    closest = boundary;
  }

  return value.length;
}

function previousBoundary(value: string, offset: number): number {
  const normalizedOffset = clampToBoundary(value, offset);
  let previous = 0;

  for (const boundary of graphemeBoundaries(value)) {
    if (boundary >= normalizedOffset) {
      return previous;
    }

    previous = boundary;
  }

  return previous;
}

function nextBoundary(value: string, offset: number): number {
  const normalizedOffset = clampToBoundary(value, offset);

  for (const boundary of graphemeBoundaries(value)) {
    if (boundary > normalizedOffset) {
      return boundary;
    }
  }

  return value.length;
}

function graphemeBoundaries(value: string): number[] {
  const boundaries = [0];

  for (const segment of graphemeSegments(value)) {
    boundaries.push(segment.index + segment.segment.length);
  }

  return boundaries;
}

function graphemeSegments(value: string): Array<{ segment: string; index: number }> {
  const segmenter = getSegmenter();

  if (segmenter) {
    return Array.from(segmenter.segment(value), (segment) => ({
      segment: segment.segment,
      index: segment.index,
    }));
  }

  let index = 0;

  return Array.from(value, (segment) => {
    const current = {
      segment,
      index,
    };
    index += segment.length;

    return current;
  });
}

function getSegmenter():
  | {
      segment(value: string): Iterable<{ segment: string; index: number }>;
    }
  | undefined {
  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locale: string,
        options: { granularity: "grapheme" },
      ) => {
        segment(value: string): Iterable<{ segment: string; index: number }>;
      };
    }
  ).Segmenter;

  return Segmenter
    ? new Segmenter("en", {
        granularity: "grapheme",
      })
    : undefined;
}
