import { describe, expect, test } from "bun:test";
import {
  ScheduledMessageManager,
  type ScheduledMessageManagerAction,
  type ScheduledMessageManagerItem,
} from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";

describe("scheduled message manager", () => {
  test("renders the supplied snapshot without exposing replacement keys", () => {
    const manager = new ScheduledMessageManager(() => {});
    const keyedItem = {
      ...item("future", "future", "agent", "Agent reminder", 14, 32, 18),
      key: "agent-internal-key",
    };
    manager.replaceItems([
      keyedItem,
      item("pending", "pending", "user", "User reminder", 14, 30, 0),
    ]);

    const rendered = stripAnsi(manager.render(100).join("\n"));

    expect(rendered.indexOf("Agent reminder")).toBeLessThan(rendered.indexOf("User reminder"));
    expect(rendered).toContain("14:32:18 · Kana · Agent reminder");
    expect(rendered).toContain("due · you · User reminder");
    expect(rendered).not.toContain("agent-internal-key");
  });

  test("preserves selection by ID when a refreshed snapshot reorders an item", () => {
    const actions: ScheduledMessageManagerAction[] = [];
    const manager = new ScheduledMessageManager((action) => actions.push(action));
    const first = item("first", "future", "agent", "First", 14, 31, 0);
    const selected = item("selected", "future", "user", "Selected", 14, 32, 0);
    manager.replaceItems([first, selected]);
    manager.handleInput("\x1b[B");

    manager.replaceItems([{ ...selected, state: "pending" }, first]);
    manager.handleInput("D");
    manager.handleInput("R");
    manager.handleInput("A");
    manager.handleInput("\x1b");

    expect(actions).toEqual([
      { type: "delete", item: { ...selected, state: "pending" } },
      { type: "refresh" },
      { type: "add" },
      { type: "close" },
    ]);
  });

  test("pages by a full window and jumps to the ends", () => {
    const actions: ScheduledMessageManagerAction[] = [];
    const manager = new ScheduledMessageManager((action) => actions.push(action), 3);
    const messages = Array.from({ length: 8 }, (_, index) =>
      item(`id-${index + 1}`, "future", "agent", `Message ${index + 1}`, 14, index, 0),
    );
    manager.replaceItems(messages);

    manager.handleInput("\x1b[6~");
    expect(selectedMessage(manager)).toContain("Message 4");

    manager.handleInput("\x1b[4~");
    expect(selectedMessage(manager)).toContain("Message 8");

    manager.handleInput("\x1b[D");
    expect(selectedMessage(manager)).toContain("Message 5");

    manager.handleInput("\x1b[1~");
    expect(selectedMessage(manager)).toContain("Message 1");

    manager.handleInput("\x1b[5~");
    manager.handleInput("D");

    expect(actions).toEqual([{ type: "delete", item: messages[0] }]);
  });
});

function selectedMessage(manager: ScheduledMessageManager): string | undefined {
  return manager
    .render(100)
    .map(stripAnsi)
    .find((line) => line.startsWith("> "));
}

function item(
  id: string,
  state: ScheduledMessageManagerItem["state"],
  origin: ScheduledMessageManagerItem["origin"],
  message: string,
  hour: number,
  minute: number,
  second: number,
): ScheduledMessageManagerItem {
  return {
    id,
    state,
    origin,
    message,
    dueAt: new Date(2026, 7, 8, hour, minute, second),
  };
}
