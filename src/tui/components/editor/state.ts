import { graphemeSegments } from "../../render";

export const LONG_PASTE_CHARACTER_THRESHOLD = 1_000;

export type CollapsedPaste = {
  startOffset: number;
  endOffset: number;
  characterCount: number;
};

export type EditorTextState = {
  value: string;
  cursorOffset: number;
  collapsedPastes?: CollapsedPaste[];
};

export type EditorDisplayPaste = CollapsedPaste & {
  displayStartOffset: number;
  displayEndOffset: number;
};

export type EditorDisplayState = {
  value: string;
  cursorOffset: number;
  collapsedPastes: EditorDisplayPaste[];
};

export type EditorDisplaySegment = {
  text: string;
  startOffset: number;
  collapsedPaste: boolean;
};

export type EditorAction =
  | {
      type: "insert";
      text: string;
    }
  | {
      type: "insertCollapsedPaste";
      text: string;
      characterCount: number;
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

export function createPasteAction(
  text: string,
  characterThreshold = LONG_PASTE_CHARACTER_THRESHOLD,
): EditorAction {
  const characterCount = graphemeSegments(text).length;

  return characterCount >= characterThreshold
    ? { type: "insertCollapsedPaste", text, characterCount }
    : { type: "insert", text };
}

export function applyEditorAction(state: EditorTextState, action: EditorAction): EditorTextState {
  const collapsedPastes = validCollapsedPastes(state);
  const cursorOffset = clampToEditorBoundary(state.value, collapsedPastes, state.cursorOffset);

  switch (action.type) {
    case "insert":
      return insertText(state, collapsedPastes, cursorOffset, action.text);
    case "insertCollapsedPaste": {
      const inserted = insertText(state, collapsedPastes, cursorOffset, action.text);
      const nextCollapsedPastes = [
        ...(inserted.collapsedPastes ?? []),
        {
          startOffset: cursorOffset,
          endOffset: cursorOffset + action.text.length,
          characterCount: action.characterCount,
        },
      ].sort((left, right) => left.startOffset - right.startOffset);

      return {
        ...inserted,
        collapsedPastes: nextCollapsedPastes,
      };
    }
    case "moveLeft":
      return {
        ...state,
        cursorOffset: previousEditorBoundary(state.value, collapsedPastes, cursorOffset),
      };
    case "moveRight":
      return {
        ...state,
        cursorOffset: nextEditorBoundary(state.value, collapsedPastes, cursorOffset),
      };
    case "moveStart":
      return {
        ...state,
        cursorOffset: 0,
      };
    case "moveEnd":
      return {
        ...state,
        cursorOffset: state.value.length,
      };
    case "deleteBefore": {
      const start = previousEditorBoundary(state.value, collapsedPastes, cursorOffset);

      return deleteTextRange(state, collapsedPastes, start, cursorOffset, start);
    }
    case "deleteAfter": {
      const end = nextEditorBoundary(state.value, collapsedPastes, cursorOffset);

      return deleteTextRange(state, collapsedPastes, cursorOffset, end, cursorOffset);
    }
  }
}

export function createEditorDisplayState(state: EditorTextState): EditorDisplayState {
  const collapsedPastes = validCollapsedPastes(state);
  const displayPastes: EditorDisplayPaste[] = [];
  let value = "";
  let sourceOffset = 0;

  for (const paste of collapsedPastes) {
    value += state.value.slice(sourceOffset, paste.startOffset);
    const displayStartOffset = value.length;
    value += formatCollapsedPaste(paste.characterCount);
    displayPastes.push({
      ...paste,
      displayStartOffset,
      displayEndOffset: value.length,
    });
    sourceOffset = paste.endOffset;
  }

  value += state.value.slice(sourceOffset);

  const projection = {
    value,
    cursorOffset: 0,
    collapsedPastes: displayPastes,
  };

  projection.cursorOffset = sourceOffsetToDisplayOffset(projection, state.cursorOffset);

  return projection;
}

export function sourceOffsetToDisplayOffset(
  display: EditorDisplayState,
  sourceOffset: number,
): number {
  let offsetDelta = 0;

  for (const paste of display.collapsedPastes) {
    if (sourceOffset < paste.startOffset) {
      break;
    }

    if (sourceOffset <= paste.endOffset) {
      if (sourceOffset === paste.startOffset) {
        return paste.displayStartOffset;
      }
      if (sourceOffset === paste.endOffset) {
        return paste.displayEndOffset;
      }

      return sourceOffset - paste.startOffset <= paste.endOffset - sourceOffset
        ? paste.displayStartOffset
        : paste.displayEndOffset;
    }

    offsetDelta +=
      paste.displayEndOffset - paste.displayStartOffset - (paste.endOffset - paste.startOffset);
  }

  return sourceOffset + offsetDelta;
}

export function displayOffsetToSourceOffset(
  display: EditorDisplayState,
  displayOffset: number,
): number {
  let offsetDelta = 0;

  for (const paste of display.collapsedPastes) {
    if (displayOffset < paste.displayStartOffset) {
      break;
    }

    if (displayOffset <= paste.displayEndOffset) {
      if (displayOffset === paste.displayStartOffset) {
        return paste.startOffset;
      }
      if (displayOffset === paste.displayEndOffset) {
        return paste.endOffset;
      }

      return displayOffset - paste.displayStartOffset <= paste.displayEndOffset - displayOffset
        ? paste.startOffset
        : paste.endOffset;
    }

    offsetDelta +=
      paste.endOffset - paste.startOffset - (paste.displayEndOffset - paste.displayStartOffset);
  }

  return displayOffset + offsetDelta;
}

export function splitEditorDisplayRange(
  display: EditorDisplayState,
  startOffset: number,
  endOffset: number,
): EditorDisplaySegment[] {
  const segments: EditorDisplaySegment[] = [];
  let offset = startOffset;

  for (const paste of display.collapsedPastes) {
    if (paste.displayEndOffset <= startOffset) {
      continue;
    }
    if (paste.displayStartOffset >= endOffset) {
      break;
    }

    const textEnd = Math.min(paste.displayStartOffset, endOffset);
    if (offset < textEnd) {
      segments.push({
        text: display.value.slice(offset, textEnd),
        startOffset: offset,
        collapsedPaste: false,
      });
    }

    const pasteStart = Math.max(offset, paste.displayStartOffset);
    const pasteEnd = Math.min(endOffset, paste.displayEndOffset);
    if (pasteStart < pasteEnd) {
      segments.push({
        text: display.value.slice(pasteStart, pasteEnd),
        startOffset: pasteStart,
        collapsedPaste: true,
      });
    }
    offset = pasteEnd;
  }

  if (offset < endOffset) {
    segments.push({
      text: display.value.slice(offset, endOffset),
      startOffset: offset,
      collapsedPaste: false,
    });
  }

  return segments;
}

export function clampToBoundary(value: string, offset: number): number {
  if (offset <= 0) {
    return 0;
  }

  if (offset >= value.length) {
    return value.length;
  }

  let closest = 0;

  for (const boundary of graphemeBoundaries(value)) {
    if (boundary > offset) {
      return closest;
    }

    closest = boundary;
  }

  return value.length;
}

export function previousBoundary(value: string, offset: number): number {
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

export function nextBoundary(value: string, offset: number): number {
  const normalizedOffset = clampToBoundary(value, offset);

  for (const boundary of graphemeBoundaries(value)) {
    if (boundary > normalizedOffset) {
      return boundary;
    }
  }

  return value.length;
}

function insertText(
  state: EditorTextState,
  collapsedPastes: CollapsedPaste[],
  cursorOffset: number,
  text: string,
): EditorTextState {
  const nextCollapsedPastes = collapsedPastes.map((paste) =>
    paste.startOffset >= cursorOffset
      ? {
          ...paste,
          startOffset: paste.startOffset + text.length,
          endOffset: paste.endOffset + text.length,
        }
      : paste,
  );

  return withCollapsedPastes(
    state,
    state.value.slice(0, cursorOffset) + text + state.value.slice(cursorOffset),
    cursorOffset + text.length,
    nextCollapsedPastes,
  );
}

function deleteTextRange(
  state: EditorTextState,
  collapsedPastes: CollapsedPaste[],
  startOffset: number,
  endOffset: number,
  cursorOffset: number,
): EditorTextState {
  if (startOffset === endOffset) {
    return {
      ...state,
      cursorOffset,
    };
  }

  const deletedLength = endOffset - startOffset;
  const nextCollapsedPastes = collapsedPastes.flatMap((paste): CollapsedPaste[] => {
    if (paste.endOffset <= startOffset) {
      return [paste];
    }
    if (paste.startOffset >= endOffset) {
      return [
        {
          ...paste,
          startOffset: paste.startOffset - deletedLength,
          endOffset: paste.endOffset - deletedLength,
        },
      ];
    }

    // Cursor navigation treats a collapsed paste as one unit, so an overlapping
    // deletion always removes the complete paste and its display metadata.
    return [];
  });

  return withCollapsedPastes(
    state,
    state.value.slice(0, startOffset) + state.value.slice(endOffset),
    cursorOffset,
    nextCollapsedPastes,
  );
}

function withCollapsedPastes(
  previous: EditorTextState,
  value: string,
  cursorOffset: number,
  collapsedPastes: CollapsedPaste[],
): EditorTextState {
  const next = {
    value,
    cursorOffset,
  };

  return previous.collapsedPastes !== undefined || collapsedPastes.length > 0
    ? { ...next, collapsedPastes }
    : next;
}

function clampToEditorBoundary(
  value: string,
  collapsedPastes: CollapsedPaste[],
  offset: number,
): number {
  if (offset <= 0) {
    return 0;
  }
  if (offset >= value.length) {
    return value.length;
  }

  let plainStartOffset = 0;

  for (const paste of collapsedPastes) {
    if (offset < paste.startOffset) {
      return (
        plainStartOffset +
        clampToBoundary(value.slice(plainStartOffset, paste.startOffset), offset - plainStartOffset)
      );
    }
    if (offset === paste.startOffset || offset === paste.endOffset) {
      return offset;
    }
    if (offset < paste.endOffset) {
      return offset - paste.startOffset <= paste.endOffset - offset
        ? paste.startOffset
        : paste.endOffset;
    }
    plainStartOffset = paste.endOffset;
  }

  return (
    plainStartOffset + clampToBoundary(value.slice(plainStartOffset), offset - plainStartOffset)
  );
}

function previousEditorBoundary(
  value: string,
  collapsedPastes: CollapsedPaste[],
  offset: number,
): number {
  let plainStartOffset = 0;

  for (let index = collapsedPastes.length - 1; index >= 0; index -= 1) {
    const paste = collapsedPastes[index];
    if (!paste) {
      continue;
    }
    if (offset > paste.startOffset && offset <= paste.endOffset) {
      return paste.startOffset;
    }
    if (paste.endOffset < offset) {
      plainStartOffset = paste.endOffset;
      break;
    }
  }

  return (
    plainStartOffset +
    previousBoundary(value.slice(plainStartOffset, offset), offset - plainStartOffset)
  );
}

function nextEditorBoundary(
  value: string,
  collapsedPastes: CollapsedPaste[],
  offset: number,
): number {
  let plainEndOffset = value.length;

  for (const paste of collapsedPastes) {
    if (offset >= paste.startOffset && offset < paste.endOffset) {
      return paste.endOffset;
    }
    if (paste.startOffset > offset) {
      plainEndOffset = paste.startOffset;
      break;
    }
  }

  return offset + nextBoundary(value.slice(offset, plainEndOffset), 0);
}

function validCollapsedPastes(state: EditorTextState): CollapsedPaste[] {
  const sorted = [...(state.collapsedPastes ?? [])]
    .filter(
      (paste) =>
        paste.startOffset >= 0 &&
        paste.endOffset > paste.startOffset &&
        paste.endOffset <= state.value.length,
    )
    .sort((left, right) => left.startOffset - right.startOffset);
  const result: CollapsedPaste[] = [];

  for (const paste of sorted) {
    if ((result.at(-1)?.endOffset ?? 0) <= paste.startOffset) {
      result.push(paste);
    }
  }

  return result;
}

function formatCollapsedPaste(characterCount: number): string {
  return `[Pasted ${new Intl.NumberFormat("en-US").format(characterCount)} chars]`;
}

function graphemeBoundaries(value: string): number[] {
  const boundaries = [0];

  for (const segment of graphemeSegments(value)) {
    boundaries.push(segment.index + segment.segment.length);
  }

  return boundaries;
}
