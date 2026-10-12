// Text and display state shared by the editor reducer, cursor boundaries, and
// the collapsed-paste display mapping.

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

export type EditorKill = {
  text: string;
  collapsedPastes: CollapsedPaste[];
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

export function validCollapsedPastes(state: EditorTextState): CollapsedPaste[] {
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

export function formatCollapsedPaste(characterCount: number): string {
  return `[Pasted ${new Intl.NumberFormat("en-US").format(characterCount)} chars]`;
}
