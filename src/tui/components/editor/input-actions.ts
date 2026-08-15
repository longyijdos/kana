import {
  isAltKey,
  isBackspace,
  isCtrlKey,
  isDelete,
  isEnd,
  isHome,
  isLeft,
  isModifiedBackspace,
  isModifiedCursorKey,
  isModifiedDelete,
  isRight,
} from "../../runtime";
import type { EditorAction } from "./state";

export function resolveEditorInputAction(data: string): EditorAction | undefined {
  if (
    isAltKey(data, "b") ||
    isModifiedCursorKey(data, "left", "alt") ||
    isModifiedCursorKey(data, "left", "ctrl")
  ) {
    return { type: "moveWordLeft" };
  }

  if (
    isAltKey(data, "f") ||
    isModifiedCursorKey(data, "right", "alt") ||
    isModifiedCursorKey(data, "right", "ctrl")
  ) {
    return { type: "moveWordRight" };
  }

  if (isLeft(data) || isCtrlKey(data, "b")) {
    return { type: "moveLeft" };
  }

  if (isRight(data) || isCtrlKey(data, "f")) {
    return { type: "moveRight" };
  }

  if (isHome(data) || isCtrlKey(data, "a")) {
    return { type: "moveLineStart" };
  }

  if (isEnd(data) || isCtrlKey(data, "e")) {
    return { type: "moveLineEnd" };
  }

  if (isModifiedBackspace(data, "alt") || isModifiedBackspace(data, "ctrl")) {
    return { type: "killWordBefore" };
  }

  if (isCtrlKey(data, "w")) {
    return { type: "killWhitespaceWordBefore" };
  }

  if (isAltKey(data, "d") || isModifiedDelete(data, "alt") || isModifiedDelete(data, "ctrl")) {
    return { type: "killWordAfter" };
  }

  if (isBackspace(data) || isCtrlKey(data, "h")) {
    return { type: "deleteBefore" };
  }

  if (isDelete(data) || isCtrlKey(data, "d")) {
    return { type: "deleteAfter" };
  }

  if (isCtrlKey(data, "u")) {
    return { type: "killLineBefore" };
  }

  if (isCtrlKey(data, "k")) {
    return { type: "killLineAfter" };
  }

  if (isCtrlKey(data, "y")) {
    return { type: "yank" };
  }

  return undefined;
}
