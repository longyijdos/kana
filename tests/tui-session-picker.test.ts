import { describe, expect, test } from "bun:test";
import type { KanaSessionMetadata } from "@/kana";
import {
  DeleteSessionConfirmation,
  SessionPicker,
  type SessionPickerDecision,
} from "../src/tui/components";
import { color, stripAnsi } from "../src/tui/render";
import { tuiTheme } from "../src/tui/theme";

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

    const rendered = picker.render(100);

    expect(rendered.map(stripAnsi)).toEqual([
      "Sessions",
      `> ${localTimestamp(sessions[0].createdAt)}  alpha-se  Explain lazy sessions  deepseek/deepseek-v4-pro`,
      `  ${localTimestamp(sessions[1].createdAt)}  bravo-se  Add fork prompt titles  unknown model`,
    ]);
    expect(rendered[0]).toBe(color("Sessions", tuiTheme.bottomTitle));

    picker.handleInput("\x1b[B");
    picker.handleInput("\r");

    expect(decisions).toEqual([
      {
        type: "select",
        session: sessions[1],
      },
    ]);
  });

  test("uses danger only for the delete confirmation title", () => {
    const confirmation = new DeleteSessionConfirmation(sessions[0], () => {});
    const rendered = confirmation.render(100);

    expect(rendered[0]).toBe(color("Delete session?", tuiTheme.error));
    expect(rendered.find((line) => line.includes("No, keep it"))).toBe(
      color("> No, keep it", tuiTheme.user),
    );
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
    const manySessions = createSessions(5);
    const picker = new SessionPicker(manySessions, () => {}, 3);

    expect(picker.render(100).map(stripAnsi)).toEqual([
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
      "Sessions",
      "... 1 earlier sessions",
      `  ${localTimestamp(manySessions[1].createdAt)}  session-  Session 2  unknown model`,
      `  ${localTimestamp(manySessions[2].createdAt)}  session-  Session 3  unknown model`,
      `> ${localTimestamp(manySessions[3].createdAt)}  session-  Session 4  unknown model`,
      "... 1 more sessions",
    ]);
  });

  test("shrinks the session window for a short available height", () => {
    const picker = new SessionPicker(createSessions(5), () => {});
    const rendered = picker.render(100, 6).map(stripAnsi);

    expect(rendered.some((line) => line.includes("Session 1"))).toBe(true);
    expect(rendered.some((line) => line.includes("Session 2"))).toBe(true);
    expect(rendered.some((line) => line.includes("Session 3"))).toBe(true);
    expect(rendered.some((line) => line.includes("Session 4"))).toBe(false);
    expect(rendered).toContain("... 2 more sessions");
  });

  test("keeps the selected session visible when available height shrinks", () => {
    const picker = new SessionPicker(createSessions(5), () => {});

    picker.render(100, 20);
    picker.handleInput("\x1b[B");
    picker.handleInput("\x1b[B");
    picker.handleInput("\x1b[B");

    const rendered = picker.render(100, 5).map(stripAnsi);

    expect(rendered.some((line) => line.includes(">") && line.includes("Session 4"))).toBe(true);
    expect(rendered.some((line) => line.includes("Session 3"))).toBe(true);
    expect(rendered.some((line) => line.includes("Session 2"))).toBe(false);
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

function createSessions(length: number): KanaSessionMetadata[] {
  return Array.from({ length }, (_, index) => ({
    id: `session-${index + 1}`,
    createdAt: `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    title: `Session ${index + 1}`,
    cwd: "/repo",
    path: `/sessions/${index + 1}.jsonl`,
  }));
}
