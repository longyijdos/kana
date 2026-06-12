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
      `> ${localTimestamp(sessions[0].createdAt)}  alpha-se  deepseek/deepseek-v4-pro`,
      `  ${localTimestamp(sessions[1].createdAt)}  bravo-se  unknown model`,
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

function localTimestamp(timestamp: string): string {
  const date = new Date(timestamp);

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + ` ${[
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join(":")}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}
