import { describe, expect, test } from "bun:test";
import type { KanaSessionMetadata } from "@/kana";
import {
  DeleteSessionConfirmation,
  SessionPicker,
  type SessionPickerDecision,
} from "../../src/tui/components";
import { color, stripAnsi } from "../../src/tui/render";
import { tuiTheme } from "../../src/tui/theme";

const HELP_LINE = "Enter resume · ↑/↓ select · ←/→ page · K delete · Esc close";

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
      `  ${localTimestamp(sessions[1].createdAt)}  bravo-se  Add fork prompt titles  Unknown model`,
      HELP_LINE,
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

  test("requests deletion with k or K instead of resuming", () => {
    const decisions: SessionPickerDecision[] = [];
    const picker = new SessionPicker(sessions, (decision) => decisions.push(decision));

    picker.handleInput("\x1b[B");
    picker.handleInput("K");

    expect(decisions).toEqual([{ type: "delete", session: sessions[1] }]);

    picker.handleInput("\x1b[A");
    picker.handleInput("k");

    expect(decisions).toEqual([
      { type: "delete", session: sessions[1] },
      { type: "delete", session: sessions[0] },
    ]);
  });

  test("ignores deletion when no session is selected", () => {
    const decisions: SessionPickerDecision[] = [];
    const picker = new SessionPicker([], (decision) => decisions.push(decision));

    picker.handleInput("K");

    expect(decisions).toEqual([]);
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

  test("keeps the selection on a nearby session after the list is replaced", () => {
    const manySessions = createSessions(3);
    const picker = new SessionPicker(manySessions, () => {}, 2);

    picker.handleInput("\x1b[B");

    expect(selectedSession(picker)).toContain("Session 2");

    picker.replaceSessions([manySessions[0], manySessions[2]]);

    expect(picker.render(100).map(stripAnsi)).toEqual([
      "Sessions",
      `  ${localTimestamp(manySessions[0].createdAt)}  session-  Session 1  Unknown model`,
      `> ${localTimestamp(manySessions[2].createdAt)}  session-  Session 3  Unknown model`,
      HELP_LINE,
    ]);

    picker.replaceSessions([]);

    expect(picker.render(100).map(stripAnsi)).toEqual([
      "Sessions",
      "No saved sessions for this workspace.",
      HELP_LINE,
    ]);
  });

  test("renders only the visible session window", () => {
    const manySessions = createSessions(5);
    const picker = new SessionPicker(manySessions, () => {}, 3);

    expect(picker.render(100).map(stripAnsi)).toEqual([
      "Sessions",
      `> ${localTimestamp(manySessions[0].createdAt)}  session-  Session 1  Unknown model`,
      `  ${localTimestamp(manySessions[1].createdAt)}  session-  Session 2  Unknown model`,
      `  ${localTimestamp(manySessions[2].createdAt)}  session-  Session 3  Unknown model`,
      "... 2 more sessions",
      HELP_LINE,
    ]);

    picker.handleInput("\x1b[B");
    picker.handleInput("\x1b[B");
    picker.handleInput("\x1b[B");

    expect(picker.render(100).map(stripAnsi)).toEqual([
      "Sessions",
      "... 1 earlier sessions",
      `  ${localTimestamp(manySessions[1].createdAt)}  session-  Session 2  Unknown model`,
      `  ${localTimestamp(manySessions[2].createdAt)}  session-  Session 3  Unknown model`,
      `> ${localTimestamp(manySessions[3].createdAt)}  session-  Session 4  Unknown model`,
      "... 1 more sessions",
      HELP_LINE,
    ]);
  });

  test("pages by a full window and jumps to the ends", () => {
    const manySessions = createSessions(12);
    const decisions: SessionPickerDecision[] = [];
    const picker = new SessionPicker(manySessions, (decision) => decisions.push(decision), 3);

    picker.handleInput("\x1b[6~");

    expect(picker.render(100).map(stripAnsi)).toEqual([
      "Sessions",
      "... 3 earlier sessions",
      `> ${localTimestamp(manySessions[3].createdAt)}  session-  Session 4  Unknown model`,
      `  ${localTimestamp(manySessions[4].createdAt)}  session-  Session 5  Unknown model`,
      `  ${localTimestamp(manySessions[5].createdAt)}  session-  Session 6  Unknown model`,
      "... 6 more sessions",
      HELP_LINE,
    ]);

    picker.handleInput("\x1b[C");
    expect(selectedSession(picker)).toContain("Session 7");

    picker.handleInput("\x1b[4~");
    expect(selectedSession(picker)).toContain("Session 12");

    picker.handleInput("\x1b[D");
    expect(selectedSession(picker)).toContain("Session 9");

    picker.handleInput("\x1b[1~");
    expect(selectedSession(picker)).toContain("Session 1");

    picker.handleInput("\x1b[5~");
    expect(selectedSession(picker)).toContain("Session 1");

    picker.handleInput("\r");
    expect(decisions).toEqual([{ type: "select", session: manySessions[0] }]);
  });
});

function selectedSession(picker: SessionPicker): string {
  return picker
    .render(100)
    .map(stripAnsi)
    .find((line) => line.startsWith("> ")) as string;
}

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
