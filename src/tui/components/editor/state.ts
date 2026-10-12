import { graphemeSegments } from "../../render";
import {
  clampToEditorBoundary,
  expandRangeToCollapsedPasteBoundaries,
  nextEditorBoundary,
  nextWordBoundary,
  previousEditorBoundary,
  previousWhitespaceWordBoundary,
  previousWordBoundary,
} from "./boundaries";
import { editorKillLineBoundary, editorLineBoundary } from "./display";
import {
  type CollapsedPaste,
  type EditorKill,
  type EditorTextState,
  validCollapsedPastes,
} from "./text-state";

export const LONG_PASTE_CHARACTER_THRESHOLD = 1_000;

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
