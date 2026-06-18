import { describe, expect, test } from "bun:test";
import type { KanaSessionMetadata } from "../src/kana";
import { WELCOME_LOGO_LINES } from "../src/tui/app/welcome-logo";
import { WelcomeBlock } from "../src/tui/components";
import { stripAnsi, visibleWidth } from "../src/tui/render";
import { KANA_VERSION } from "../src/version";

const LOGO = ["\x1b[48;2;0;120;0m    \x1b[0m"];
const SESSIONS: KanaSessionMetadata[] = [
  {
    id: "alpha-session",
    createdAt: "2026-06-13T00:00:00.000Z",
    title: "Wire recent sessions",
    cwd: "/tmp/kana",
    path: "/sessions/a.jsonl",
  },
  {
    id: "bravo-session",
    createdAt: "2026-06-12T00:00:00.000Z",
    title: "Trim welcome panel",
    cwd: "/tmp/kana",
    path: "/sessions/b.jsonl",
  },
];

describe("tui welcome block", () => {
  test("renders a boxed welcome panel at desktop widths", () => {
    const lines = new WelcomeBlock({
      logoLines: LOGO,
      recentSessions: SESSIONS,
      username: "tester",
    }).render(80);

    expect(stripAnsi(lines[0] ?? "")).toContain(`Kana v${KANA_VERSION}`);
    expect(lines.every((line) => visibleWidth(line) === 74)).toBe(true);
    expect(stripAnsi(lines.join("\n"))).toContain("Welcome back, tester");
    expect(stripAnsi(lines.join("\n"))).toContain("Recent activity");
    expect(stripAnsi(lines.join("\n"))).toContain("Highlights");
    expect(stripAnsi(lines.join("\n"))).toContain("... /help for more");
    expect(stripAnsi(lines.join("\n"))).toContain("Wire recent sessions");
    expect(stripAnsi(lines.join("\n"))).toContain("Trim welcome panel");
    expect(stripAnsi(lines.join("\n"))).not.toContain("Start a new conversation");
    expect(stripAnsi(lines.join("\n"))).not.toContain("What's new");
    expect(stripAnsi(lines.join("\n"))).not.toContain("/tmp/kana");
    expect(stripAnsi(lines.join("\n"))).not.toContain("Tips");
    expect(stripAnsi(lines.join("\n"))).not.toContain("Type a prompt");
  });

  test("uses a compact layout at narrow widths", () => {
    const lines = new WelcomeBlock({
      logoLines: LOGO,
    }).render(30);

    expect(stripAnsi(lines[0] ?? "")).toBe("Kana");
    expect(lines.every((line) => visibleWidth(line) <= 30)).toBe(true);
    expect(stripAnsi(lines.join("\n"))).toContain("Plan, edit, and ship");
    expect(stripAnsi(lines.join("\n"))).not.toContain("Recent activity");
  });

  test("invites a new conversation when there are no recent sessions", () => {
    const lines = new WelcomeBlock({
      logoLines: LOGO,
      username: "tester",
    }).render(80);

    const rendered = stripAnsi(lines.join("\n"));

    expect(rendered).toContain("No recent sessions yet");
    expect(rendered).toContain("Start a conversation");
    expect(rendered).toContain("Your work will appear here");
  });

  test("keeps the default logo compact within the welcome panel", () => {
    expect(WELCOME_LOGO_LINES).toHaveLength(7);
    expect(Math.max(...WELCOME_LOGO_LINES.map(visibleWidth))).toBeLessThanOrEqual(22);
  });
});
