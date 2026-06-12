import { describe, expect, test } from "bun:test";
import type { KanaSessionMetadata } from "@/kana";
import {
  SessionPicker,
  type SessionPickerDecision,
} from "../src/tui/components";
import { stripAnsi } from "../src/tui/render";

const sessions: KanaSessionMetadata[] = [
  {
    id: "alpha-session",
    createdAt: "2026-06-12T00:00:00.000Z",
    cwd: "/repo",
    path: "/sessions/a.jsonl",
    model: {
      provider: "deepseek",
      model: "deepseek-v4-pro",
    },
  },
  {
    id: "bravo-session",
    createdAt: "2026-06-13T00:00:00.000Z",
    cwd: "/repo",
    path: "/sessions/b.jsonl",
  },
];

describe("session picker", () => {
  test("renders sessions and selects with enter", () => {
    const decisions: SessionPickerDecision[] = [];
    const picker = new SessionPicker(sessions, (decision) => {
      decisions.push(decision);
    });

    expect(picker.render(100).map(stripAnsi)).toEqual([
      "",
      "Sessions",
      "> 2026-06-12 00:00:00  alpha-se  deepseek/deepseek-v4-pro",
      "  2026-06-13 00:00:00  bravo-se  unknown model",
    ]);

    picker.handleInput("\x1b[B");
    picker.handleInput("\r");

    expect(decisions).toEqual([
      {
        type: "select",
        session: sessions[1],
      },
    ]);
  });

  test("cancels with escape", () => {
    const decisions: SessionPickerDecision[] = [];
    const picker = new SessionPicker(sessions, (decision) => {
      decisions.push(decision);
    });

    picker.handleInput("\x1b");

    expect(decisions).toEqual([
      {
        type: "cancel",
      },
    ]);
  });
});
