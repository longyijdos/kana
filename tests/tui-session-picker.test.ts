import { describe, expect, test } from "bun:test";
import type { KanaSessionMetadata } from "@/kana";
import { SessionPicker, type SessionPickerDecision } from "../src/tui/components";
import { stripAnsi } from "../src/tui/render";

const sessions: KanaSessionMetadata[] = [
  {
    id: "alpha-session",
    createdAt: "2026-06-12T00:00:00.000Z",
    title: "Explain lazy sessions",
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
    title: "Add fork prompt titles",
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
      `> ${localTimestamp(sessions[0].createdAt)}  alpha-se  Explain lazy sessions  deepseek/deepseek-v4-pro`,
      `  ${localTimestamp(sessions[1].createdAt)}  bravo-se  Add fork prompt titles  unknown model`,
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

  test("renders only the visible session window", () => {
    const manySessions: KanaSessionMetadata[] = Array.from({ length: 5 }, (_, index) => ({
      id: `session-${index + 1}`,
      createdAt: `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      title: `Session ${index + 1}`,
      cwd: "/repo",
      path: `/sessions/${index + 1}.jsonl`,
    }));
    const picker = new SessionPicker(manySessions, () => {}, 3);

    expect(picker.render(100).map(stripAnsi)).toEqual([
      "",
      "Sessions",
      `> ${localTimestamp(manySessions[0].createdAt)}  session-  Session 1  unknown model`,
      `  ${localTimestamp(manySessions[1].createdAt)}  session-  Session 2  unknown model`,
      `  ${localTimestamp(manySessions[2].createdAt)}  session-  Session 3  unknown model`,
      "... 2 more sessions",
    ]);

    picker.handleInput("\x1b[B");
    picker.handleInput("\x1b[B");
    picker.handleInput("\x1b[B");

    expect(picker.render(100).map(stripAnsi)).toEqual([
      "",
      "Sessions",
      "... 1 earlier sessions",
      `  ${localTimestamp(manySessions[1].createdAt)}  session-  Session 2  unknown model`,
      `  ${localTimestamp(manySessions[2].createdAt)}  session-  Session 3  unknown model`,
      `> ${localTimestamp(manySessions[3].createdAt)}  session-  Session 4  unknown model`,
      "... 1 more sessions",
    ]);
  });

  test("does not wrap selection at list boundaries", () => {
    const decisions: SessionPickerDecision[] = [];
    const picker = new SessionPicker(sessions, (decision) => {
      decisions.push(decision);
    });

    picker.handleInput("\x1b[A");
    picker.handleInput("\r");

    expect(decisions.at(-1)).toEqual({
      type: "select",
      session: sessions[0],
    });

    picker.handleInput("\x1b[B");
    picker.handleInput("\x1b[B");
    picker.handleInput("\r");

    expect(decisions.at(-1)).toEqual({
      type: "select",
      session: sessions[1],
    });
  });
});

function localTimestamp(timestamp: string): string {
  const date = new Date(timestamp);

  return `${[date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-")} ${[
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join(":")}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}
