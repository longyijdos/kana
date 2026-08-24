import { countKanaTodos, type KanaTodoItem } from "@/kana";
import { color, visibleWidth, wrapPlainText } from "../../render";
import { tuiTheme } from "../../theme";

const STATUS_MARKERS: Record<KanaTodoItem["status"], string> = {
  pending: "○",
  in_progress: "◉",
  completed: "✓",
};

export function formatTodoTarget(items: readonly KanaTodoItem[]): string | undefined {
  if (items.length === 0) {
    return undefined;
  }

  const active = items.find((item) => item.status === "in_progress");
  return [formatTodoCounts(items), active?.content.replace(/\s+/g, " ").trim()]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

export function renderTodoState(items: readonly KanaTodoItem[], width: number): string[] {
  if (items.length === 0) {
    return [color("No todos.", tuiTheme.toolOutput)];
  }

  const lines = [
    ...wrapPlainText(formatTodoCounts(items), width).map((line) =>
      color(line, tuiTheme.toolOutput),
    ),
    "",
  ];
  for (const item of items) {
    const prefix = `${STATUS_MARKERS[item.status]} `;
    const content = item.content.replace(/\s+/g, " ").trim();
    const wrapped = wrapPlainText(content, Math.max(1, width - visibleWidth(prefix)));
    lines.push(color(`${prefix}${wrapped[0] ?? ""}`, tuiTheme.toolOutput));
    for (const continuation of wrapped.slice(1)) {
      lines.push(color(`  ${continuation}`, tuiTheme.toolOutput));
    }
  }
  return lines;
}

function formatTodoCounts(items: readonly KanaTodoItem[]): string {
  const counts = countKanaTodos(items);
  return `${counts.in_progress} active · ${counts.pending} pending · ${counts.completed} completed`;
}
