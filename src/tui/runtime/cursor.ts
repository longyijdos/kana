// OSC marker used only inside rendered lines. Tui strips it before writing and
// moves the hardware cursor to the marker's visual column for IME composition.
export const CURSOR_MARKER = "\x1b]kana;cursor\x07";

export function stripCursorMarker(value: string): string {
  return value.split(CURSOR_MARKER).join("");
}
