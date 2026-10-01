import { describe, expect, test } from "bun:test";
import type {
  MemoryConsolidationActivity,
  MemoryConsolidationActivitySource,
  MemoryConsolidationEvent,
} from "@/kana";
import { MemoryActivityController } from "../../src/tui/app/memory-activity-controller";
import { Editor } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import { Tui } from "../../src/tui/runtime";
import { createTerminalStub } from "./app-fixture";

describe("memory activity controller", () => {
  test("projects host activity and failure without changing the foreground phase", () => {
    let activity: MemoryConsolidationActivity[] = [{ scope: "project", status: "queued" }];
    const listeners = new Set<(event: MemoryConsolidationEvent) => void>();
    const source: MemoryConsolidationActivitySource = {
      getActivity: () => activity,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const editor = new Editor();
    editor.updateStatus({ phase: "working", running: true });
    const errors: string[] = [];
    const controller = new MemoryActivityController({
      source,
      editor,
      tui: new Tui(createTerminalStub()),
      showError: (error) => errors.push(error),
    });
    const render = () => stripAnsi(editor.render(96).join("\n"));
    const publish = (event: MemoryConsolidationEvent) => {
      for (const listener of listeners) listener(event);
    };
    controller.bind();
    expect(controller.active).toBe(true);
    expect(render()).toContain("Memory · queued project");

    activity = [{ scope: "project", status: "organizing" }];
    publish({ type: "activity_changed" });
    expect(render()).toContain("Memory · organizing project");
    publish({ type: "failed", scope: "project", error: "Provider unavailable" });
    expect(errors).toEqual(["Memory consolidation failed · project · Provider unavailable"]);
    expect(render()).toContain("Working");

    activity = [];
    publish({ type: "activity_changed" });
    expect(controller.active).toBe(false);
    expect(render()).not.toContain("Memory · ");
    expect(render()).not.toContain("organized");
    controller.unbind();
    expect(listeners.size).toBe(0);
  });
});
