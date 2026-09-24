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
const NOW = Date.parse("2026-09-23T12:00:00.000Z");

const sessions: KanaSessionMetadata[] = [
  {
    id: "alpha-session",
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-09-23T11:58:00.000Z",
    title: "Explain lazy sessions",
    cwd: "/repo",
    path: "/sessions/a.jsonl",
  },
  {
    id: "bravo-session",
    createdAt: "2026-06-13T00:00:00.000Z",
    updatedAt: "2026-09-20T12:00:00.000Z",
    title: "Add fork prompt titles",
    cwd: "/repo",
    path: "/sessions/b.jsonl",
  },
];

describe("session picker", () => {
  test("renders sessions and selects with enter", () => {
    const decisions: SessionPickerDecision[] = [];
    const picker = createPicker(sessions, (decision) => {
      decisions.push(decision);
    });

    const rendered = picker.render(100);

    expect(rendered.map(stripAnsi)).toEqual([
      "Sessions",
      "> 2m ago       alpha-se  Explain lazy sessions",
      "  3d ago       bravo-se  Add fork prompt titles",
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

  test("formats recent activity as relative time and older activity as a date", () => {
    const activitySessions = [
      activitySession("seconds", "2026-09-23T11:59:30.000Z"),
      activitySession("minutes", "2026-09-23T11:48:00.000Z"),
      activitySession("hours", "2026-09-23T09:00:00.000Z"),
      activitySession("days", "2026-09-19T12:00:00.000Z"),
      activitySession("this-year", localNoon(2026, 8, 12)),
      activitySession("last-year", localNoon(2025, 11, 18)),
    ];

    expect(
      createPicker(activitySessions, () => {})
        .render(100)
        .map(stripAnsi),
    ).toEqual([
      "Sessions",
      "> just now     seconds  Session seconds",
      "  12m ago      minutes  Session minutes",
      "  3h ago       hours  Session hours",
      "  4d ago       days  Session days",
      "  Sep 12       this-yea  Session this-year",
      "  2025-12-18   last-yea  Session last-year",
      HELP_LINE,
    ]);
  });

  test("requests deletion with k or K instead of resuming", () => {
    const decisions: SessionPickerDecision[] = [];
    const picker = createPicker(sessions, (decision) => decisions.push(decision));

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
    const picker = createPicker([], (decision) => decisions.push(decision));

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
    const picker = createPicker(sessions, (decision) => {
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
    const picker = createPicker(manySessions, () => {}, 2);

    picker.handleInput("\x1b[B");

    expect(selectedSession(picker)).toContain("Session 2");

    picker.replaceSessions([manySessions[0], manySessions[2]]);

    expect(picker.render(100).map(stripAnsi)).toEqual([
      "Sessions",
      `  ${expectedRow(manySessions[0])}`,
      `> ${expectedRow(manySessions[2])}`,
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
    const picker = createPicker(manySessions, () => {}, 3);

    expect(picker.render(100).map(stripAnsi)).toEqual([
      "Sessions",
      `> ${expectedRow(manySessions[0])}`,
      `  ${expectedRow(manySessions[1])}`,
      `  ${expectedRow(manySessions[2])}`,
      "... 2 more sessions",
      HELP_LINE,
    ]);

    picker.handleInput("\x1b[B");
    picker.handleInput("\x1b[B");
    picker.handleInput("\x1b[B");

    expect(picker.render(100).map(stripAnsi)).toEqual([
      "Sessions",
      "... 1 earlier sessions",
      `  ${expectedRow(manySessions[1])}`,
      `  ${expectedRow(manySessions[2])}`,
      `> ${expectedRow(manySessions[3])}`,
      "... 1 more sessions",
      HELP_LINE,
    ]);
  });

  test("pages by a full window and jumps to the ends", () => {
    const manySessions = createSessions(12);
    const decisions: SessionPickerDecision[] = [];
    const picker = createPicker(manySessions, (decision) => decisions.push(decision), 3);

    picker.handleInput("\x1b[6~");

    expect(picker.render(100).map(stripAnsi)).toEqual([
      "Sessions",
      "... 3 earlier sessions",
      `> ${expectedRow(manySessions[3])}`,
      `  ${expectedRow(manySessions[4])}`,
      `  ${expectedRow(manySessions[5])}`,
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

function createPicker(
  sessions: KanaSessionMetadata[],
  finish: (decision: SessionPickerDecision) => void,
  visibleLimit?: number,
): SessionPicker {
  return new SessionPicker(sessions, finish, visibleLimit, () => NOW);
}

function selectedSession(picker: SessionPicker): string {
  return picker
    .render(100)
    .map(stripAnsi)
    .find((line) => line.startsWith("> ")) as string;
}

// The focused tests above pin the exact column layout; window and paging
// assertions only need each row to stay identifiable, so their fixtures share
// one relative activity label that reads the same in every timezone.
function expectedRow(session: KanaSessionMetadata): string {
  return `${"30m ago".padEnd(13)}${session.id.slice(0, 8)}  ${session.title}`;
}

function activitySession(id: string, updatedAt: string): KanaSessionMetadata {
  return {
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    title: `Session ${id}`,
    cwd: "/repo",
    path: `/sessions/${id}.jsonl`,
  };
}

// Absolute activity labels are rendered in local time, so these cases are built
// from local noon to keep the expected dates timezone-independent.
function localNoon(year: number, monthIndex: number, day: number): string {
  return new Date(year, monthIndex, day, 12, 0, 0).toISOString();
}

function createSessions(length: number): KanaSessionMetadata[] {
  return Array.from({ length }, (_, index) => ({
    id: `session-${index + 1}`,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-09-23T11:30:00.000Z",
    title: `Session ${index + 1}`,
    cwd: "/repo",
    path: `/sessions/${index + 1}.jsonl`,
  }));
}
