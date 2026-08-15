import { describe, expect, test } from "bun:test";
import { QueuedInputController } from "../../src/tui/app/queued-input-controller";
import type { EditorQueuedInput, EditorScheduledInputSummary } from "../../src/tui/components";
import { messageIdentityForTest, messageIdForTest } from "../helpers/messages";

describe("QueuedInputController", () => {
  test("projects turn input before the runtime FIFO and summarizes future wakes", () => {
    const snapshots: EditorQueuedInput[][] = [];
    const scheduled: Array<EditorScheduledInputSummary | undefined> = [];
    const controller = new QueuedInputController((inputs, summary) => {
      snapshots.push(inputs);
      scheduled.push(summary);
    });
    const nextAt = new Date("2026-08-08T08:05:00.000Z");

    controller.addTurn({
      ...messageIdentityForTest("user"),
      role: "user",
      content: "Queued with Enter.",
      images: [
        {
          mimeType: "image/png",
          data: "aW1hZ2U=",
          width: 32,
          height: 16,
        },
      ],
    });
    controller.syncRuntimeQueue({
      pending: [
        {
          id: messageIdForTest("tab-1"),
          kind: "queued",
          content: "Queued with Tab.",
          imageCount: 2,
        },
        {
          id: messageIdForTest("wake-1"),
          kind: "scheduled",
          content: "Check progress.",
          dueAt: nextAt,
          origin: "agent",
        },
      ],
      scheduled: [
        {
          id: messageIdForTest("wake-2"),
          sessionId: "session-a",
          dueAt: nextAt,
          message: "Later.",
          origin: "agent",
        },
        {
          id: messageIdForTest("wake-3"),
          sessionId: "session-a",
          dueAt: new Date("2026-08-08T08:10:00.000Z"),
          message: "Later again.",
          origin: "user",
        },
      ],
    });

    expect(snapshots.at(-1)).toEqual([
      { content: "Queued with Enter.", imageCount: 1, delivery: "turn" },
      { content: "Queued with Tab.", imageCount: 2, delivery: "run" },
      { content: "Check progress.", delivery: "scheduled" },
    ]);
    expect(scheduled.at(-1)).toEqual({ count: 2, nextAt });
  });

  test("reconciles a deferred fallback by the original message id", () => {
    const snapshots: EditorQueuedInput[][] = [];
    const controller = new QueuedInputController((inputs) => {
      snapshots.push(inputs);
    });

    const firstId = controller.addTurn("Follow up.");
    const queue = {
      pending: [
        {
          id: firstId,
          kind: "deferred" as const,
          content: "Follow up.",
        },
      ],
      scheduled: [],
    };
    controller.syncRuntimeQueue(queue);

    expect(snapshots.at(-1)).toEqual([{ content: "Follow up.", delivery: "run" }]);

    controller.addTurn("Follow up.");
    controller.syncRuntimeQueue(queue);

    expect(snapshots.at(-1)).toEqual([
      { content: "Follow up.", delivery: "turn" },
      { content: "Follow up.", delivery: "run" },
    ]);
  });
});
