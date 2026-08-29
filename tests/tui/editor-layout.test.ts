import { describe, expect, test } from "bun:test";
import {
  createInputLayout,
  moveInputCursorVertically,
} from "../../src/tui/components/editor/input-layout";

describe("input layout", () => {
  test("uses one line by default", () => {
    expect(
      createInputLayout({
        value: "hello",
        cursorOffset: 5,
        columns: 10,
        maxLines: 3,
      }),
    ).toMatchObject({
      lines: [
        {
          text: "hello",
        },
      ],
      cursor: {
        line: 0,
        column: 5,
      },
      isTruncatedStart: false,
    });
  });

  test("wraps up to the maximum and truncates earlier lines", () => {
    expect(
      createInputLayout({
        value: "abcdefghijkl",
        cursorOffset: 12,
        columns: 3,
        maxLines: 3,
      }),
    ).toMatchObject({
      lines: [
        {
          text: "def",
        },
        {
          text: "ghi",
        },
        {
          text: "jkl",
        },
      ],
      cursor: {
        line: 2,
        column: 3,
      },
      isTruncatedStart: true,
    });
  });

  test("keeps the cursor visible when it moves inside wrapped text", () => {
    expect(
      createInputLayout({
        value: "abcdefghijkl",
        cursorOffset: 4,
        columns: 3,
        maxLines: 2,
      }),
    ).toMatchObject({
      lines: [
        {
          text: "abc",
        },
        {
          text: "def",
        },
      ],
      cursor: {
        line: 1,
        column: 1,
      },
      isTruncatedStart: false,
    });
  });

  test("places the cursor on the next line at a wrapped boundary", () => {
    expect(
      createInputLayout({
        value: "abcdef",
        cursorOffset: 3,
        columns: 3,
        maxLines: 3,
      }),
    ).toMatchObject({
      lines: [
        {
          text: "abc",
        },
        {
          text: "def",
        },
      ],
      cursor: {
        line: 1,
        column: 0,
      },
    });
  });

  test("keeps the cursor on the only line when text exactly fills it", () => {
    expect(
      createInputLayout({
        value: "abc",
        cursorOffset: 3,
        columns: 3,
        maxLines: 3,
      }),
    ).toMatchObject({
      lines: [
        {
          text: "abc",
        },
      ],
      cursor: {
        line: 0,
        column: 3,
      },
    });
  });

  test("keeps cursor offsets aligned across CRLF and CR line breaks", () => {
    expect(
      createInputLayout({
        value: "a\r\nb\rc",
        cursorOffset: 5,
        columns: 10,
        maxLines: 5,
      }),
    ).toMatchObject({
      lines: [
        {
          text: "a",
        },
        {
          text: "b",
        },
        {
          text: "c",
        },
      ],
      cursor: {
        line: 2,
        column: 0,
      },
    });
  });

  test("moves the cursor vertically between wrapped input lines", () => {
    expect(
      moveInputCursorVertically({
        value: "abc\ndef",
        cursorOffset: 7,
        columns: 10,
        direction: -1,
      }),
    ).toBe(3);

    expect(
      moveInputCursorVertically({
        value: "abcdef",
        cursorOffset: 0,
        columns: 3,
        direction: 1,
      }),
    ).toBe(3);
  });

  test("does not move vertically beyond input boundaries", () => {
    expect(
      moveInputCursorVertically({
        value: "abc",
        cursorOffset: 0,
        columns: 10,
        direction: -1,
      }),
    ).toBeUndefined();

    expect(
      moveInputCursorVertically({
        value: "abc",
        cursorOffset: 3,
        columns: 10,
        direction: 1,
      }),
    ).toBeUndefined();
  });

  test("accounts for wide characters", () => {
    expect(
      createInputLayout({
        value: "你好a",
        cursorOffset: 3,
        columns: 4,
        maxLines: 3,
      }),
    ).toMatchObject({
      lines: [
        {
          text: "你好",
        },
        {
          text: "a",
        },
      ],
      cursor: {
        line: 1,
        column: 1,
      },
    });
  });
});
