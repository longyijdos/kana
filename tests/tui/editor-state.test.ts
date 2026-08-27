import { describe, expect, test } from "bun:test";
import { applyEditorAction, createEditorDisplayState } from "../../src/tui/components/editor/state";

describe("editor state", () => {
  test("inserts text at the cursor", () => {
    const moved = applyEditorAction(
      {
        value: "helo",
        cursorOffset: 4,
      },
      {
        type: "moveLeft",
      },
    );

    expect(
      applyEditorAction(moved, {
        type: "insert",
        text: "l",
      }),
    ).toEqual({
      value: "hello",
      cursorOffset: 4,
    });
  });

  test("moves over grapheme clusters", () => {
    const value = "a👨‍👩‍👧‍👦b";
    const moved = applyEditorAction(
      {
        value,
        cursorOffset: value.length,
      },
      {
        type: "moveLeft",
      },
    );

    expect(moved.cursorOffset).toBe(value.length - 1);

    expect(
      applyEditorAction(moved, {
        type: "moveLeft",
      }).cursorOffset,
    ).toBe(1);
  });

  test("deletes complete grapheme clusters", () => {
    const value = "a👨‍👩‍👧‍👦b";

    expect(
      applyEditorAction(
        {
          value,
          cursorOffset: value.length - 1,
        },
        {
          type: "deleteBefore",
        },
      ),
    ).toEqual({
      value: "ab",
      cursorOffset: 1,
    });
  });
  test("keeps collapsed pastes atomic across word, line, kill, and yank actions", () => {
    const pastedText = "pasted\ncontent";
    const pasteStart = "before".length;
    const pasteEnd = pasteStart + pastedText.length;
    const state = {
      value: `before${pastedText}after\nnext`,
      cursorOffset: pasteEnd,
      collapsedPastes: [
        {
          startOffset: pasteStart,
          endOffset: pasteEnd,
          characterCount: 14,
        },
      ],
    };

    expect(applyEditorAction(state, { type: "moveWordLeft" }).cursorOffset).toBe(pasteStart);
    expect(
      applyEditorAction({ ...state, cursorOffset: pasteStart }, { type: "moveWordRight" })
        .cursorOffset,
    ).toBe(pasteEnd);
    expect(
      applyEditorAction({ ...state, cursorOffset: 0 }, { type: "moveLineEnd" }).cursorOffset,
    ).toBe(pasteEnd + "after".length);

    const killed = applyEditorAction(state, { type: "killWordBefore" });
    expect(killed.value).toBe("beforeafter\nnext");
    expect(killed.killBuffer).toEqual({
      text: pastedText,
      collapsedPastes: [
        {
          startOffset: 0,
          endOffset: pastedText.length,
          characterCount: 14,
        },
      ],
    });

    const yanked = applyEditorAction(killed, { type: "yank" });
    expect(yanked.value).toBe(state.value);
    expect(yanked.collapsedPastes).toEqual(state.collapsedPastes);
    expect(createEditorDisplayState(yanked).value).toContain("[Pasted 14 chars]");
  });
});
