import { describe, expect, test } from "bun:test";
import type { KanaSessionMetadata } from "../../src/kana";
import { WELCOME_LOGO_LINES } from "../../src/tui/app/welcome-logo";
import { WelcomeBlock } from "../../src/tui/components";
import { stripAnsi, visibleWidth } from "../../src/tui/render";
import { KANA_VERSION } from "../../src/version";

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
    expect(lines.every((line) => visibleWidth(line) === 73)).toBe(true);
    const renderedLines = lines.map(stripAnsi);
    const rendered = renderedLines.join("\n");
    const greetingLine = renderedLines.find((line) => line.includes("Welcome back"));
    const [, leftColumn, rightColumn] = greetingLine?.split("|") ?? [];
    const highlightsLine = renderedLines.findIndex((line) => line.includes("Highlights"));
    const helpLine = renderedLines.findIndex((line) => line.includes("... /help for more"));

    expect(visibleWidth(leftColumn ?? "")).toBe(35);
    expect(visibleWidth(rightColumn ?? "")).toBe(35);
    expect(rendered).toContain("Welcome back, tester");
    expect(rendered).toContain("Recent activity");
    expect(rendered).toContain("Highlights");
    expect(helpLine - highlightsLine - 1).toBe(3);
    expect(rendered).not.toContain("Session runtime logs");
    expect(rendered).toContain("... /help for more");
    expect(rendered).toContain("Wire recent sessions");
    expect(rendered).toContain("Trim welcome panel");
    expect(rendered).not.toContain("Start a new conversation");
    expect(rendered).not.toContain("What's new");
    expect(rendered).not.toContain("/tmp/kana");
    expect(rendered).not.toContain("Tips");
    expect(rendered).not.toContain("Type a prompt");
  });

  test("shows an ellipsis when a recent session title is truncated", () => {
    const title = "帮我做一次只读检查，看一下我的五分钟后提醒";
    const renderedLines = new WelcomeBlock({
      logoLines: LOGO,
      recentSessions: [{ ...SESSIONS[0]!, title }],
      username: "tester",
    })
      .render(80)
      .map(stripAnsi);

    const sessionLine = renderedLines.find((line) => line.includes("帮我做一次"));
    const sessionColumn = sessionLine?.split("|")[2];

    expect(sessionLine).toBeDefined();
    expect(sessionColumn?.trimEnd().endsWith("...")).toBe(true);
    expect(sessionLine).not.toContain(title);
  });

  test("uses a compact layout at narrow widths", () => {
    const lines = new WelcomeBlock({
      logoLines: LOGO,
    }).render(72);

    expect(stripAnsi(lines[0] ?? "")).toBe("Kana");
    expect(lines.every((line) => visibleWidth(line) <= 72)).toBe(true);
    expect(stripAnsi(lines.join("\n"))).toContain("Plan, act, and follow through");
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

  test("explains temporary clean sessions without a resume hint", () => {
    const lines = new WelcomeBlock({
      logoLines: LOGO,
      savedSessionsAvailable: false,
      username: "tester",
    }).render(80);

    const rendered = stripAnsi(lines.join("\n"));

    expect(rendered).toContain("Temporary clean session");
    expect(rendered).toContain("Nothing will be saved");
    expect(rendered).toContain("Discarded on exit");
    expect(rendered).not.toContain("/resume");
  });

  test("keeps the default logo compact within the welcome panel", () => {
    expect(WELCOME_LOGO_LINES).toHaveLength(7);
    expect(Math.max(...WELCOME_LOGO_LINES.map(visibleWidth))).toBeLessThanOrEqual(22);
  });
});
