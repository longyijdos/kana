import { describe, expect, test } from "bun:test";
import {
  type ToolHistoryEntry,
  ToolHistoryPicker,
  type ToolHistoryPickerDecision,
} from "../../src/tui/components";
import { stripAnsi, visibleWidth } from "../../src/tui/render";

const entries: ToolHistoryEntry[] = [
  { toolCallId: "call_c", title: "Bash", summary: "bun test tests/tui/..." },
  { toolCallId: "call_b", title: "Edit", summary: "src/tui/tools/format.ts" },
  { toolCallId: "call_a", title: "custom_lookup" },
];

describe("tool history picker", () => {
  test("renders each entry as one row with the newest selected first", () => {
    const picker = new ToolHistoryPicker(entries, () => {});

    const lines = picker.render(80).map(stripAnsi);

    expect(lines[0]).toBe("Tool history");
    expect(lines[1]).toBe("> Bash  bun test tests/tui/...");
    expect(lines[2]).toBe("  Edit  src/tui/tools/format.ts");
    expect(lines[3]).toBe("  custom_lookup");
    expect(lines).toHaveLength(4);
  });

  test("selects the highlighted entry with enter using its stable id", () => {
    const decisions: ToolHistoryPickerDecision[] = [];
    const picker = new ToolHistoryPicker(entries, (decision) => decisions.push(decision));

    picker.handleInput("\r");

    expect(decisions).toEqual([{ type: "select", toolCallId: "call_c" }]);
  });

  test("moves the selection with up and down and wraps at the boundaries", () => {
    const decisions: ToolHistoryPickerDecision[] = [];
    const picker = new ToolHistoryPicker(entries, (decision) => decisions.push(decision));

    picker.handleInput("\x1b[B");
    picker.handleInput("\r");
    expect(decisions).toEqual([{ type: "select", toolCallId: "call_b" }]);

    picker.handleInput("\x1b[B");
    picker.handleInput("\r");
    expect(decisions[1]).toEqual({ type: "select", toolCallId: "call_a" });

    picker.handleInput("\x1b[B");
    picker.handleInput("\r");
    expect(decisions[2]).toEqual({ type: "select", toolCallId: "call_a" });

    picker.handleInput("\x1b[A");
    picker.handleInput("\r");
    expect(decisions[3]).toEqual({ type: "select", toolCallId: "call_b" });
  });

  test("esc cancels", () => {
    const decisions: ToolHistoryPickerDecision[] = [];
    const picker = new ToolHistoryPicker(entries, (decision) => decisions.push(decision));

    picker.handleInput("\x1b");

    expect(decisions).toEqual([{ type: "cancel" }]);
  });

  test("renders an empty state and still cancels with esc", () => {
    const decisions: ToolHistoryPickerDecision[] = [];
    const picker = new ToolHistoryPicker([], (decision) => decisions.push(decision));

    const lines = picker.render(80).map(stripAnsi);

    expect(lines).toEqual(["Tool history", "No tool calls in this session."]);

    picker.handleInput("\x1b");
    expect(decisions).toEqual([{ type: "cancel" }]);
  });

  test("keeps membership, order, and selection stable across resizes", () => {
    const picker = new ToolHistoryPicker(entries, () => {});

    expect(picker.render(120, 14).map(stripAnsi)[1]).toBe("> Bash  bun test tests/tui/...");

    picker.handleInput("\x1b[B");
    picker.handleInput("\x1b[B");

    const narrow = picker.render(40, 6).map(stripAnsi);
    const wide = picker.render(120, 30).map(stripAnsi);

    // The selected entry is the third one (custom_lookup) in every render.
    for (const lines of [narrow, wide]) {
      const selected = lines.find((line) => line.startsWith("> "));
      expect(selected).toBe("> custom_lookup");
    }

    // Visible rows keep the snapshot's newest-first order as a subsequence.
    const visibleTitles = narrow.filter((line) => line.startsWith("> ") || line.startsWith("  "));
    expect(visibleTitles).toEqual([
      "  Bash  bun test tests/tui/...",
      "  Edit  src/tui/tools/format.ts",
      "> custom_lookup",
    ]);
  });

  test("bounds the viewport for a short available height", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      toolCallId: `call_${index}`,
      title: `Tool ${index}`,
    }));
    const picker = new ToolHistoryPicker(many, () => {});

    const lines = picker.render(80, 7).map(stripAnsi);

    expect(lines[0]).toBe("Tool history");
    expect(lines[1]).toBe("> Tool 0");
    expect(lines[2]).toBe("  Tool 1");
    expect(lines[3]).toBe("  Tool 2");
    expect(lines[4]).toBe("  Tool 3");
    expect(lines[5]).toBe("... 16 more tools");
    expect(lines).toHaveLength(6);
  });

  test("keeps a long command and a long custom name on one truncated row", () => {
    const long = entries.map((entry) => ({
      ...entry,
      summary: entry.summary === undefined ? undefined : `${entry.summary} ${"x".repeat(200)}`,
    }));
    const longName = [...long, { toolCallId: "call_long", title: `custom_${"y".repeat(120)}` }];
    const picker = new ToolHistoryPicker(longName, () => {});

    const lines = picker.render(48).map(stripAnsi);

    expect(lines.length).toBe(5);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(48);
      expect(line).not.toContain("\n");
    }
  });
});
