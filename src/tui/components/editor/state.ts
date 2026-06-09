export type EditorTextState = {
  value: string;
  cursorOffset: number;
};

export type EditorAction =
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

export function applyEditorAction(
  state: EditorTextState,
  action: EditorAction,
): EditorTextState {
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

export function firstGrapheme(value: string): string | undefined {
  return graphemeSegments(value)[0]?.segment;
}

function graphemeBoundaries(value: string): number[] {
  const boundaries = [0];

  for (const segment of graphemeSegments(value)) {
    boundaries.push(segment.index + segment.segment.length);
  }

  return boundaries;
}

function graphemeSegments(value: string): Array<{ segment: string; index: number }> {
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

  if (Segmenter) {
    return Array.from(
      new Segmenter("en", { granularity: "grapheme" }).segment(value),
      (segment) => ({
        segment: segment.segment,
        index: segment.index,
      }),
    );
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
