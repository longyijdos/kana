import { describe, expect, test } from "bun:test";
import { QueuedInputController } from "../../src/tui/app/queued-input-controller";
import type { EditorQueuedInput } from "../../src/tui/components";

describe("QueuedInputController", () => {
  test("orders turn input before run input and moves deferred steering to the FIFO tail", () => {
    const snapshots: EditorQueuedInput[][] = [];
    const controller = new QueuedInputController((inputs) => {
      snapshots.push(inputs);
    });

    controller.add("Queued with Tab.", "run");
    const steeringId = controller.add("Queued with Enter.", "turn");

    expect(snapshots.at(-1)).toEqual([
      { content: "Queued with Enter.", delivery: "turn" },
      { content: "Queued with Tab.", delivery: "run" },
    ]);

    controller.moveToRun(steeringId);

    expect(snapshots.at(-1)).toEqual([
      { content: "Queued with Tab.", delivery: "run" },
      { content: "Queued with Enter.", delivery: "run" },
    ]);
  });

  test("removes a fallback run that starts before its steering preview changes lanes", () => {
    const snapshots: EditorQueuedInput[][] = [];
    const controller = new QueuedInputController((inputs) => {
      snapshots.push(inputs);
    });

    const id = controller.add("Follow up.", "turn");
    controller.startRun("Follow up.");
    controller.moveToRun(id);

    expect(snapshots.at(-1)).toEqual([]);
  });
});
