import { afterEach, describe, expect, jest, test } from "bun:test";
import { Editor } from "../../src/tui/components";
import { StdinBuffer } from "../../src/tui/runtime/stdin-buffer";
import { resolveEscapeTimeoutMs } from "../../src/tui/runtime/terminal";

const PASTE = "\x1b[200~first\r\nsecond\x1b[201~";
const LOGICAL_INPUT = [
  "a",
  "界",
  "😀",
  "\r",
  "\x1b[D",
  "\x1bOA",
  "\x1b[100;3u",
  "\x1b[27;3;100~",
  "\x1b]0;title\x07",
  "\x1bP>|version\x1b\\",
  "\x1b_Gpayload\x1b\\",
  PASTE,
  "z",
];
const INPUT_STREAM = LOGICAL_INPUT.join("");

afterEach(() => {
  jest.useRealTimers();
});

describe("stdin buffer", () => {
  test("frames the same logical input at every two-chunk boundary", () => {
    for (let boundary = 0; boundary <= INPUT_STREAM.length; boundary += 1) {
      expect(frame([INPUT_STREAM.slice(0, boundary), INPUT_STREAM.slice(boundary)])).toEqual(
        LOGICAL_INPUT,
      );
    }
  });

  test("reassembles escape sequences and paste delimiters one code unit at a time", () => {
    expect(frame(INPUT_STREAM.split(""))).toEqual(LOGICAL_INPUT);
  });

  test("dispatches batched printable input and Enter independently to the editor", () => {
    for (const chunks of [["abc\r"], ["ab", "c\r"], ["a", "b", "c", "\r"]]) {
      const submitted: string[] = [];
      const editor = new Editor();
      const buffer = new StdinBuffer((data) => editor.handleInput(data));
      editor.onSubmit = (input) => {
        if (input.type === "message") {
          submitted.push(input.content);
        }
      };

      for (const chunk of chunks) {
        buffer.process(chunk);
      }

      buffer.destroy();
      expect(submitted).toEqual(["abc"]);
    }
  });

  test("delivers fragmented bracketed paste to the editor as one event", () => {
    const submitted: string[] = [];
    const editor = new Editor();
    const buffer = new StdinBuffer((data) => editor.handleInput(data));
    editor.onSubmit = (input) => {
      if (input.type === "message") {
        submitted.push(input.content);
      }
    };

    for (const chunk of `${PASTE}\r`.split("")) {
      buffer.process(chunk);
    }

    buffer.destroy();
    expect(submitted).toEqual(["first\nsecond"]);
  });

  test("uses distinct timeouts for a lone Escape and other incomplete sequences", () => {
    jest.useFakeTimers();
    const emitted: string[] = [];
    const buffer = new StdinBuffer((data) => emitted.push(data), {
      escapeTimeoutMs: 100,
      sequenceTimeoutMs: 20,
    });

    buffer.process("\x1b");
    jest.advanceTimersByTime(99);
    expect(emitted).toEqual([]);
    buffer.process("[D");
    expect(emitted).toEqual(["\x1b[D"]);

    buffer.process("\x1b[1;");
    jest.advanceTimersByTime(20);
    expect(emitted).toEqual(["\x1b[D", "\x1b[1;"]);

    buffer.process("\x1b");
    jest.advanceTimersByTime(100);
    expect(emitted).toEqual(["\x1b[D", "\x1b[1;", "\x1b"]);
    buffer.destroy();
  });

  test("clears pending input and timers when destroyed", () => {
    jest.useFakeTimers();
    const emitted: string[] = [];
    const buffer = new StdinBuffer((data) => emitted.push(data));

    buffer.process("\x1b");
    buffer.destroy();
    jest.advanceTimersByTime(100);

    expect(emitted).toEqual([]);
  });

  test("stops dispatching a batch when input handling destroys the buffer", () => {
    const emitted: string[] = [];
    let buffer: StdinBuffer;
    buffer = new StdinBuffer((data) => {
      emitted.push(data);
      buffer.destroy();
    });

    buffer.process("abc");

    expect(emitted).toEqual(["a"]);
  });
});

describe("terminal Escape timeout", () => {
  test("uses a longer reassembly window for SSH sessions", () => {
    expect(resolveEscapeTimeoutMs({})).toBe(10);
    expect(resolveEscapeTimeoutMs({ SSH_CONNECTION: "client server" })).toBe(100);
    expect(resolveEscapeTimeoutMs({ SSH_CLIENT: "client" })).toBe(100);
    expect(resolveEscapeTimeoutMs({ SSH_TTY: "/dev/pts/1" })).toBe(100);
  });
});

function frame(chunks: string[]): string[] {
  const emitted: string[] = [];
  const buffer = new StdinBuffer((data) => emitted.push(data));

  for (const chunk of chunks) {
    buffer.process(chunk);
  }

  buffer.destroy();
  return emitted;
}
