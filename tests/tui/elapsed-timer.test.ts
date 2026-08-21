import { describe, expect, test } from "bun:test";
import {
  AssistantMessageBlock,
  ToolCallBlock,
  ToolPreparationBlock,
} from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import { ElapsedTimer } from "../../src/tui/utils/elapsed-timer";

describe("tui elapsed timer", () => {
  test("reports whole elapsed seconds while active and after stopping", () => {
    let now = 0;
    const timer = new ElapsedTimer(() => now);

    timer.start();
    now = 1_999;
    expect(timer.elapsedSeconds()).toBe(1);

    timer.stop();
    now = 10_000;
    expect(timer.elapsedSeconds()).toBe(1);
  });

  test("updates the working placeholder as time advances", () => {
    let now = 0;
    const block = new AssistantMessageBlock(() => now);
    block.showWorking(true);

    expect(stripAnsi(block.render(80)[0] ?? "")).toBe("Working (0s) (Esc to abort)");

    now = 2_000;
    expect(stripAnsi(block.render(80)[0] ?? "")).toBe("Working (2s) (Esc to abort)");
  });

  test("tracks aggregate tool preparation separately from tool execution", () => {
    let now = 0;
    const preparation = new ToolPreparationBlock(() => now);

    now = 2_000;
    preparation.stopTimer();
    now = 5_000;
    expect(stripAnsi(preparation.render(80)[0] ?? "")).toBe("Preparing tools (2s)");

    const block = new ToolCallBlock(
      {
        type: "tool_call",
        id: "call_1",
        name: "bash",
        args: { command: "pwd" },
      },
      () => now,
    );

    block.markExecutionStarted();
    now = 7_000;
    expect(stripAnsi(block.render(80)[0] ?? "")).toBe("◆ Running (2s) (Esc to abort)");

    block.updateResult({ command: "pwd", exitCode: 0, stdout: "/tmp" }, false);
    expect(stripAnsi(block.render(80)[0] ?? "")).toBe("◆ Ran");
  });
});
