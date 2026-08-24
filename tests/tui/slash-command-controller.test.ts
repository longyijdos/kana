import { describe, expect, test } from "bun:test";

import {
  type SlashCommand,
  SlashCommandController,
} from "../../src/tui/app/slash-command-controller";

describe("slash command controller", () => {
  test("routes validated commands to interaction actions", () => {
    const harness = createHarness();

    harness.handle("help");
    harness.handle("fork", "Continue here");
    harness.handle("resume", "session-a");
    harness.handle("resume");
    harness.handle("approval");
    harness.handle("model");
    harness.handle("schedule");
    harness.handle("todo");
    harness.handle("tools");
    harness.handle("image", '"/tmp/image with spaces.png"');
    harness.handle("compact");

    expect(harness.events).toEqual([
      "help",
      "fork:Continue here",
      "resume:session-a",
      "resume-picker",
      "approval",
      "model",
      "schedule",
      "todo",
      "tools",
      'image:"/tmp/image with spaces.png"',
      "compact",
    ]);
  });

  test("reports usage errors without invoking the target action", () => {
    const harness = createHarness();

    harness.handle("help", "extra");
    harness.handle("fork");
    harness.handle("image");
    harness.handle("approval", "never");
    harness.handle("usage", "global");
    harness.handle("todo", "extra");
    harness.handle("tools", "extra");

    expect(harness.events).toEqual([
      "error:Usage: /help",
      "error:Usage: /fork <prompt>",
      "error:Usage: /image <path>",
      "error:Usage: /approval",
      "error:Usage: /usage",
      "error:Usage: /todo",
      "error:Usage: /tools",
    ]);
  });

  test("preserves message fallbacks and permits quit while running", () => {
    const harness = createHarness(true);

    harness.handle("clear", "this transcript");
    harness.handle("new");
    harness.handle("quit", "later");
    harness.handle("quit");

    expect(harness.events).toEqual(["submit:/quit later", "stop"]);
  });
});

function createHarness(running = false) {
  const events: string[] = [];
  const controller = new SlashCommandController({
    isRunning: () => running,
    stop: () => events.push("stop"),
    submitRaw: (raw) => events.push(`submit:${raw}`),
    showError: (error) => events.push(`error:${error.message}`),
    showHelp: () => events.push("help"),
    clear: () => events.push("clear"),
    startNewSession: () => events.push("new"),
    forkSession: (prompt) => events.push(`fork:${prompt}`),
    resumeSession: (sessionId) => events.push(`resume:${sessionId}`),
    openResumePicker: () => events.push("resume-picker"),
    openDeletePicker: () => events.push("delete-picker"),
    openSkillManager: () => events.push("skills"),
    openMcpServerManager: () => events.push("mcp"),
    openScheduledMessageManager: () => events.push("schedule"),
    openTodo: () => events.push("todo"),
    openToolHistory: () => events.push("tools"),
    attachImageFile: (path) => events.push(`image:${path}`),
    openApproval: () => events.push("approval"),
    openModel: () => {
      events.push("model");
      return true;
    },
    openMemory: () => events.push("memory"),
    compactContext: () => events.push("compact"),
    openUsage: () => events.push("usage"),
  });

  return {
    events,
    handle(name: SlashCommand["name"], arguments_ = "") {
      controller.handle({
        type: "command",
        name,
        arguments: arguments_,
        raw: `/${name}${arguments_ ? ` ${arguments_}` : ""}`,
      });
    },
  };
}
