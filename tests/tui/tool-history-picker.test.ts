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

  test("keeps the selected tool visible in a height-constrained viewport", () => {
    const decisions: ToolHistoryPickerDecision[] = [];
    const many = Array.from({ length: 6 }, (_, index) => ({
      toolCallId: `call_${index}`,
      title: `Tool ${index}`,
    }));
    const picker = new ToolHistoryPicker(many, (decision) => decisions.push(decision));

    for (let index = 0; index < 4; index += 1) {
      picker.handleInput("\x1b[B");
    }

    const lines = picker.render(80, 7).map(stripAnsi);

    expect(lines).toEqual([
      "Tool history",
      "... 1 earlier tools",
      "  Tool 1",
      "  Tool 2",
      "  Tool 3",
      "> Tool 4",
      "... 1 more tools",
    ]);

    picker.handleInput("\r");
    expect(decisions).toEqual([{ type: "select", toolCallId: "call_4" }]);
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
