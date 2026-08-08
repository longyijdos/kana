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
    expect(rendered).toContain("14:32:18 · agent · Agent reminder");
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
});

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
