import {
  type CollapsedPaste,
  type EditorDisplayPaste,
  type EditorDisplaySegment,
  type EditorDisplayState,
  type EditorTextState,
  formatCollapsedPaste,
  validCollapsedPastes,
} from "./text-state";

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

function sourceOffsetToDisplayOffset(display: EditorDisplayState, sourceOffset: number): number {
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

export function editorLineBoundary(
  state: EditorTextState,
  collapsedPastes: CollapsedPaste[],
  cursorOffset: number,
  boundary: "start" | "end",
): number {
  const display = createEditorDisplayState({
    ...state,
    cursorOffset,
    collapsedPastes,
  });
  const displayBoundary = currentDisplayLineBoundary(display, boundary);

  return displayOffsetToSourceOffset(display, displayBoundary);
}

export function editorKillLineBoundary(
  state: EditorTextState,
  collapsedPastes: CollapsedPaste[],
  cursorOffset: number,
  boundary: "start" | "end",
): number {
  const display = createEditorDisplayState({
    ...state,
    cursorOffset,
    collapsedPastes,
  });
  let displayBoundary = currentDisplayLineBoundary(display, boundary);

  // Readline's forward kill consumes the newline when the cursor is already
  // at the logical line end. Its backward line discard is a no-op at line start.
  if (
    boundary === "end" &&
    display.cursorOffset === displayBoundary &&
    displayBoundary < display.value.length
  ) {
    displayBoundary += 1;
  }

  return displayOffsetToSourceOffset(display, displayBoundary);
}

function currentDisplayLineBoundary(
  display: EditorDisplayState,
  boundary: "start" | "end",
): number {
  if (boundary === "start") {
    return display.cursorOffset === 0
      ? 0
      : display.value.lastIndexOf("\n", display.cursorOffset - 1) + 1;
  }

  const newlineOffset = display.value.indexOf("\n", display.cursorOffset);

  return newlineOffset === -1 ? display.value.length : newlineOffset;
}
