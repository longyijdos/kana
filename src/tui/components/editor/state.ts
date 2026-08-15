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
  // Readline-style kill commands use one reusable slot rather than a full kill ring.
  killBuffer?: EditorKill;
};

type EditorKill = {
  text: string;
  collapsedPastes: CollapsedPaste[];
};

type EditorDisplayPaste = CollapsedPaste & {
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
      type: "moveWordLeft";
    }
  | {
      type: "moveWordRight";
    }
  | {
      type: "moveLineStart";
    }
  | {
      type: "moveLineEnd";
    }
  | {
      type: "deleteBefore";
    }
  | {
      type: "deleteAfter";
    }
  | {
      type: "killWordBefore";
    }
  | {
      type: "killWhitespaceWordBefore";
    }
  | {
      type: "killWordAfter";
    }
  | {
      type: "killLineBefore";
    }
  | {
      type: "killLineAfter";
    }
  | {
      type: "yank";
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
    case "moveWordLeft":
      return {
        ...state,
        cursorOffset: previousWordBoundary(state.value, collapsedPastes, cursorOffset),
      };
    case "moveWordRight":
      return {
        ...state,
        cursorOffset: nextWordBoundary(state.value, collapsedPastes, cursorOffset),
      };
    case "moveLineStart":
      return {
        ...state,
        cursorOffset: editorLineBoundary(state, collapsedPastes, cursorOffset, "start"),
      };
    case "moveLineEnd":
      return {
        ...state,
        cursorOffset: editorLineBoundary(state, collapsedPastes, cursorOffset, "end"),
      };
    case "deleteBefore": {
      const start = previousEditorBoundary(state.value, collapsedPastes, cursorOffset);

      return deleteTextRange(state, collapsedPastes, start, cursorOffset, start);
    }
    case "deleteAfter": {
      const end = nextEditorBoundary(state.value, collapsedPastes, cursorOffset);

      return deleteTextRange(state, collapsedPastes, cursorOffset, end, cursorOffset);
    }
    case "killWordBefore": {
      const start = previousWordBoundary(state.value, collapsedPastes, cursorOffset);

      return deleteTextRange(state, collapsedPastes, start, cursorOffset, start, true);
    }
    case "killWhitespaceWordBefore": {
      const start = previousWhitespaceWordBoundary(state.value, collapsedPastes, cursorOffset);

      return deleteTextRange(state, collapsedPastes, start, cursorOffset, start, true);
    }
    case "killWordAfter": {
      const end = nextWordBoundary(state.value, collapsedPastes, cursorOffset);

      return deleteTextRange(state, collapsedPastes, cursorOffset, end, cursorOffset, true);
    }
    case "killLineBefore": {
      const start = editorKillLineBoundary(state, collapsedPastes, cursorOffset, "start");

      return deleteTextRange(state, collapsedPastes, start, cursorOffset, start, true);
    }
    case "killLineAfter": {
      const end = editorKillLineBoundary(state, collapsedPastes, cursorOffset, "end");

      return deleteTextRange(state, collapsedPastes, cursorOffset, end, cursorOffset, true);
    }
    case "yank":
      return state.killBuffer
        ? insertKilledText(state, collapsedPastes, cursorOffset, state.killBuffer)
        : state;
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

function clampToBoundary(value: string, offset: number): number {
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

function insertKilledText(
  state: EditorTextState,
  collapsedPastes: CollapsedPaste[],
  cursorOffset: number,
  killed: EditorKill,
): EditorTextState {
  const inserted = insertText(state, collapsedPastes, cursorOffset, killed.text);

  if (killed.collapsedPastes.length === 0) {
    return inserted;
  }

  return {
    ...inserted,
    collapsedPastes: [
      ...(inserted.collapsedPastes ?? []),
      ...killed.collapsedPastes.map((paste) => ({
        ...paste,
        startOffset: cursorOffset + paste.startOffset,
        endOffset: cursorOffset + paste.endOffset,
      })),
    ].sort((left, right) => left.startOffset - right.startOffset),
  };
}

function deleteTextRange(
  state: EditorTextState,
  collapsedPastes: CollapsedPaste[],
  startOffset: number,
  endOffset: number,
  cursorOffset: number,
  storeKill = false,
): EditorTextState {
  [startOffset, endOffset] = expandRangeToCollapsedPasteBoundaries(
    collapsedPastes,
    startOffset,
    endOffset,
  );
  cursorOffset = Math.min(cursorOffset, startOffset);

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

  const next = withCollapsedPastes(
    state,
    state.value.slice(0, startOffset) + state.value.slice(endOffset),
    cursorOffset,
    nextCollapsedPastes,
  );

  return storeKill
    ? {
        ...next,
        killBuffer: {
          text: state.value.slice(startOffset, endOffset),
          collapsedPastes: collapsedPastes
            .filter((paste) => paste.startOffset >= startOffset && paste.endOffset <= endOffset)
            .map((paste) => ({
              ...paste,
              startOffset: paste.startOffset - startOffset,
              endOffset: paste.endOffset - startOffset,
            })),
        },
      }
    : next;
}

function withCollapsedPastes(
  previous: EditorTextState,
  value: string,
  cursorOffset: number,
  collapsedPastes: CollapsedPaste[],
): EditorTextState {
  const { collapsedPastes: _previousCollapsedPastes, ...previousState } = previous;
  const next = {
    ...previousState,
    value,
    cursorOffset,
  };

  return previous.collapsedPastes !== undefined || collapsedPastes.length > 0
    ? { ...next, collapsedPastes }
    : next;
}

function expandRangeToCollapsedPasteBoundaries(
  collapsedPastes: CollapsedPaste[],
  startOffset: number,
  endOffset: number,
): [number, number] {
  for (const paste of collapsedPastes) {
    if (paste.startOffset < endOffset && paste.endOffset > startOffset) {
      startOffset = Math.min(startOffset, paste.startOffset);
      endOffset = Math.max(endOffset, paste.endOffset);
    }
  }

  return [startOffset, endOffset];
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

function previousWordBoundary(
  value: string,
  collapsedPastes: CollapsedPaste[],
  offset: number,
): number {
  const units = createEditorUnits(value, collapsedPastes);
  let index = previousEditorUnitIndex(units, offset);
  let current = offset;

  while (index >= 0 && !isWordUnit(units[index])) {
    current = units[index]?.startOffset ?? current;
    index -= 1;
  }
  if (units[index]?.kind === "paste") {
    return units[index].startOffset;
  }
  while (index >= 0 && units[index]?.kind === "word") {
    current = units[index]?.startOffset ?? current;
    index -= 1;
  }

  return current;
}

function nextWordBoundary(
  value: string,
  collapsedPastes: CollapsedPaste[],
  offset: number,
): number {
  const units = createEditorUnits(value, collapsedPastes);
  let index = nextEditorUnitIndex(units, offset);
  let current = offset;

  while (index < units.length && !isWordUnit(units[index])) {
    current = units[index]?.endOffset ?? current;
    index += 1;
  }
  if (units[index]?.kind === "paste") {
    return units[index].endOffset;
  }
  while (index < units.length && units[index]?.kind === "word") {
    current = units[index]?.endOffset ?? current;
    index += 1;
  }

  return current;
}

function previousWhitespaceWordBoundary(
  value: string,
  collapsedPastes: CollapsedPaste[],
  offset: number,
): number {
  const units = createEditorUnits(value, collapsedPastes);
  let index = previousEditorUnitIndex(units, offset);
  let current = offset;

  while (index >= 0 && units[index]?.kind === "whitespace") {
    current = units[index]?.startOffset ?? current;
    index -= 1;
  }
  while (index >= 0 && units[index]?.kind !== "whitespace") {
    current = units[index]?.startOffset ?? current;
    index -= 1;
  }

  return current;
}

type EditorUnit = {
  startOffset: number;
  endOffset: number;
  kind: "word" | "whitespace" | "punctuation" | "paste";
};

function createEditorUnits(value: string, collapsedPastes: CollapsedPaste[]): EditorUnit[] {
  const units: EditorUnit[] = [];
  let sourceOffset = 0;

  for (const paste of collapsedPastes) {
    appendPlainEditorUnits(units, value.slice(sourceOffset, paste.startOffset), sourceOffset);
    units.push({
      startOffset: paste.startOffset,
      endOffset: paste.endOffset,
      kind: "paste",
    });
    sourceOffset = paste.endOffset;
  }

  appendPlainEditorUnits(units, value.slice(sourceOffset), sourceOffset);

  return units;
}

function appendPlainEditorUnits(units: EditorUnit[], value: string, sourceOffset: number): void {
  for (const grapheme of graphemeSegments(value)) {
    const text = grapheme.segment;
    const startOffset = sourceOffset + grapheme.index;
    units.push({
      startOffset,
      endOffset: startOffset + text.length,
      kind: /^\s+$/u.test(text)
        ? "whitespace"
        : /^[\p{L}\p{N}_]+$/u.test(text)
          ? "word"
          : "punctuation",
    });
  }
}

function isWordUnit(unit: EditorUnit | undefined): boolean {
  return unit?.kind === "word" || unit?.kind === "paste";
}

function previousEditorUnitIndex(units: EditorUnit[], offset: number): number {
  for (let index = units.length - 1; index >= 0; index -= 1) {
    if ((units[index]?.endOffset ?? Number.POSITIVE_INFINITY) <= offset) {
      return index;
    }
  }

  return -1;
}

function nextEditorUnitIndex(units: EditorUnit[], offset: number): number {
  for (const [index, unit] of units.entries()) {
    if (unit.startOffset >= offset) {
      return index;
    }
  }

  return units.length;
}

function editorLineBoundary(
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

function editorKillLineBoundary(
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
