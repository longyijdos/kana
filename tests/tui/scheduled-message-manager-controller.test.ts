import { describe, expect, test } from "bun:test";
import { readMessageId } from "@/core";
import type {
  ConversationInputQueueSnapshot,
  ConversationScheduledInputCancellation,
  WakeEvent,
} from "../../src/kana";
import { AppLayout } from "../../src/tui/app/app-layout";
import { ScheduledMessageManagerController } from "../../src/tui/app/scheduled-message-manager-controller";
import { Editor, Transcript } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Component, Tui } from "../../src/tui/runtime";

describe("scheduled message manager controller", () => {
  test("keeps a static snapshot until R refreshes it, then restores the queued-run gate", () => {
    const harness = createHarness([wake("first", "First reminder", "agent", 5)]);

    harness.controller.open();
    harness.queue.scheduled.push(wake("second", "Second reminder", "user", 10));

    expect(harness.renderFocus()).toContain("First reminder");
    expect(harness.renderFocus()).not.toContain("Second reminder");
    expect(harness.loadCount()).toBe(1);

    harness.press("R");

    expect(harness.renderFocus()).toContain("Second reminder");
    expect(harness.renderFocus()).not.toContain("Schedule refreshed");
    expect(harness.loadCount()).toBe(2);

    harness.press("\x1b");
    expect(harness.controller.active).toBe(false);
    expect(harness.closeCount()).toBe(1);
    expect(harness.tui.getFocus()).toBe(harness.editor);
  });

  test("adds preset and custom relative schedules and refreshes after each action", () => {
    const harness = createHarness();
    harness.controller.open();

    harness.press("A");
    harness.press("\r");
    harness.press("Check the build");
    harness.press("\r");

    harness.press("A");
    for (let index = 0; index < 4; index += 1) {
      harness.press("\x1b[B");
    }
    harness.press("\r");
    harness.press("2h");
    harness.press("\r");
    harness.press("Review the result");
    harness.press("\r");

    expect(harness.scheduled).toEqual([
      { afterMinutes: 5, message: "Check the build" },
      { afterMinutes: 120, message: "Review the result" },
    ]);
    expect(harness.renderFocus()).toContain("Check the build");
    expect(harness.renderFocus()).toContain("Review the result");
    expect(harness.loadCount()).toBe(3);
  });

  test("passes disabled long-paste collapsing to scheduled message prompts", () => {
    const harness = createHarness([], { collapseLongPastes: false });
    const pastedText = "x".repeat(1_000);
    harness.controller.open();

    harness.press("A");
    harness.press("\r");
    harness.press(`\x1b[200~${pastedText}\x1b[201~`);

    expect(harness.renderFocus()).not.toContain("[Pasted");

    harness.press("\x7f");
    harness.press("\r");

    expect(harness.scheduled).toEqual([{ afterMinutes: 5, message: "x".repeat(999) }]);
  });

  test("handles a stale delete by stable ID and clears its warning on manual refresh", () => {
    const harness = createHarness([wake("old", "Old reminder", "agent", 5)], {
      cancel: (id, queue) => {
        expect(id).toBe("old");
        queue.scheduled = [wake("replacement", "Replacement reminder", "agent", 10)];
        return "not_found";
      },
    });
    harness.controller.open();

    harness.press("D");
    harness.press("\x1b[B");
    harness.press("\r");

    expect(harness.cancelled).toEqual(["old"]);
    expect(harness.renderFocus()).toContain("Replacement reminder");
    expect(harness.renderFocus()).toContain("Task already changed or removed.");

    harness.press("R");
    expect(harness.renderFocus()).not.toContain("Task already changed or removed.");
  });
});

type HarnessOptions = {
  collapseLongPastes?: boolean;
  cancel?: (
    id: string,
    queue: ConversationInputQueueSnapshot,
  ) => ConversationScheduledInputCancellation;
};

function createHarness(initial: WakeEvent[] = [], options: HarnessOptions = {}) {
  const editor = new Editor({ model: "test-model" });
  const transcript = new Transcript();
  const layout = new AppLayout({ main: transcript, bottom: editor });
  const tui = createTuiStub();
  const queue: ConversationInputQueueSnapshot = {
    pending: [],
    scheduled: initial.map(cloneWake),
  };
  const scheduled: Array<{ afterMinutes: number; message: string }> = [];
  const cancelled: string[] = [];
  const errors: unknown[] = [];
  let loads = 0;
  let closes = 0;
  let nextId = 0;
  const controller = new ScheduledMessageManagerController({
    editor,
    layout,
    tui,
    getQueue: () => {
      loads += 1;
      return structuredClone(queue);
    },
    schedule: (afterMinutes, message) => {
      scheduled.push({ afterMinutes, message });
      nextId += 1;
      const event = wake(`manual-${nextId}`, message, "user", afterMinutes);
      queue.scheduled.push(event);
      queue.scheduled.sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime());
      return cloneWake(event);
    },
    cancel: (id) => {
      cancelled.push(id);
      if (options.cancel) {
        return options.cancel(id, queue);
      }
      const index = queue.scheduled.findIndex((event) => event.id === id);
      if (index < 0) {
        return "not_found";
      }
      queue.scheduled.splice(index, 1);
      return "future";
    },
    showError: (error) => errors.push(error),
    collapseLongPastes: options.collapseLongPastes,
    restoreBottom: (focus) => {
      layout.showBottom(editor);
      if (focus) {
        tui.setFocus(editor);
      }
    },
    onClose: () => {
      closes += 1;
    },
  });

  return {
    controller,
    editor,
    layout,
    tui,
    queue,
    scheduled,
    cancelled,
    errors,
    loadCount: () => loads,
    closeCount: () => closes,
    press(data: string) {
      tui.getFocus()?.handleInput?.(data);
    },
    renderFocus() {
      return stripAnsi(tui.getFocus()?.render(120).join("\n") ?? "");
    },
  };
}

function wake(
  id: string,
  message: string,
  origin: WakeEvent["origin"],
  afterMinutes: number,
): WakeEvent {
  return {
    id: readMessageId(id),
    sessionId: "session-a",
    dueAt: new Date(Date.UTC(2026, 7, 8, 8, afterMinutes, 18)),
    message,
    origin,
  };
}

function cloneWake(event: WakeEvent): WakeEvent {
  return { ...event, dueAt: new Date(event.dueAt.getTime()) };
}

function createTuiStub(): Tui {
  let focusedComponent: Component | undefined;

  return {
    requestRender: () => {},
    getFocus: () => focusedComponent,
    setFocus: (component: Component | undefined) => {
      focusedComponent = component;
    },
  } as unknown as Tui;
}
