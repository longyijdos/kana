import { graphemeSegments } from "../../render";
import type { CollapsedPaste } from "./text-state";

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

export function expandRangeToCollapsedPasteBoundaries(
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

export function clampToEditorBoundary(
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

export function previousEditorBoundary(
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

export function nextEditorBoundary(
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

export function previousWordBoundary(
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
  const paste = units[index];
  if (paste?.kind === "paste") {
    return paste.startOffset;
  }
  while (index >= 0 && units[index]?.kind === "word") {
    current = units[index]?.startOffset ?? current;
    index -= 1;
  }

  return current;
}

export function nextWordBoundary(
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
  const paste = units[index];
  if (paste?.kind === "paste") {
    return paste.endOffset;
  }
  while (index < units.length && units[index]?.kind === "word") {
    current = units[index]?.endOffset ?? current;
    index += 1;
  }

  return current;
}

export function previousWhitespaceWordBoundary(
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

function graphemeBoundaries(value: string): number[] {
  const boundaries = [0];

  for (const segment of graphemeSegments(value)) {
    boundaries.push(segment.index + segment.segment.length);
  }

  return boundaries;
}
