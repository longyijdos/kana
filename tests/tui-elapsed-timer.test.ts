import { describe, expect, test } from "bun:test";
import { AssistantMessageBlock, ToolCallBlock } from "../src/tui/components";
import { stripAnsi } from "../src/tui/render";
import { ElapsedTimer } from "../src/tui/utils/elapsed-timer";

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

  test("updates the thinking placeholder as time advances", () => {
    let now = 0;
    const block = new AssistantMessageBlock(() => now);
    block.showThinking(true);

    expect(stripAnsi(block.render(80)[0] ?? "")).toBe("thinking (0s) (Esc to abort)");

    now = 2_000;
    expect(stripAnsi(block.render(80)[0] ?? "")).toBe("thinking (2s) (Esc to abort)");
  });

  test("freezes preparation time for approval and restarts it for execution", () => {
    let now = 0;
    const block = new ToolCallBlock(
      {
        type: "tool_call",
        id: "call_1",
        name: "bash",
        args: { command: "pwd" },
      },
      () => now,
    );

    now = 2_000;
    block.freezePreparation();
    now = 5_000;
    expect(stripAnsi(block.render(80)[1] ?? "")).toBe("◆ Preparing bash (2s)");

    block.markExecutionStarted();
    now = 7_000;
    expect(stripAnsi(block.render(80)[1] ?? "")).toBe("◆ Running (2s) (Esc to abort)");

    block.updateResult({ command: "pwd", exitCode: 0, stdout: "/tmp" }, false);
    expect(stripAnsi(block.render(80)[1] ?? "")).toBe("◆ Ran");
  });
});
