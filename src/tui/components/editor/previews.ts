import type { MemoryConsolidationActivity } from "@/kana";
import { color, dim, stripTerminalControlSequences, truncateToWidth } from "../../render";
import { tuiTheme } from "../../theme";

export type EditorQueuedInput = {
  content: string;
  imageCount?: number;
  delivery: "turn" | "run" | "scheduled";
};

export type EditorScheduledInputSummary = {
  count: number;
  nextAt: Date;
};

export type EditorBackgroundActivityItem = {
  kind: "subagent" | "job";
  id: string;
  status: string;
  label: string;
};

export type EditorUserTaskItem = {
  id: string;
  label: string;
};

export type EditorInputPreviews = {
  readonly queuedInputs: readonly EditorQueuedInput[];
  readonly scheduledInputSummary?: EditorScheduledInputSummary;
  readonly backgroundActivity: readonly EditorBackgroundActivityItem[];
  readonly pendingUserTasks: readonly EditorUserTaskItem[];
};

const QUEUED_INPUT_VISIBLE_LIMIT = 5;
const BACKGROUND_ACTIVITY_VISIBLE_LIMIT = 4;
const USER_TASK_VISIBLE_LIMIT = 4;

export function hasInputPreviews(previews: EditorInputPreviews): boolean {
  return (
    previews.queuedInputs.length > 0 ||
    previews.scheduledInputSummary !== undefined ||
    previews.pendingUserTasks.length > 0 ||
    previews.backgroundActivity.length > 0
  );
}

// Renders the sections above the input within `availableHeight` rows: queued
// inputs, the scheduled-wake summary, user tasks, then background work.
export function renderInputPreviews(
  previews: EditorInputPreviews,
  width: number,
  availableHeight?: number,
): string[] {
  if (availableHeight !== undefined && availableHeight <= 0) {
    return [];
  }
  const { queuedInputs, scheduledInputSummary, pendingUserTasks, backgroundActivity } = previews;
  const remaining = (used: number) =>
    availableHeight === undefined ? undefined : Math.max(0, availableHeight - used);

  const reserveScheduledRow =
    scheduledInputSummary !== undefined &&
    queuedInputs.length > 0 &&
    (availableHeight === undefined || availableHeight > 1);
  const lines = renderSection(
    `Queued inputs · ${queuedInputs.length}`,
    queuedInputs.map((input) => {
      const delivery =
        input.delivery === "turn"
          ? "next turn"
          : input.delivery === "run"
            ? "next run"
            : "scheduled";
      const preview = [
        normalizeLabel(input.content),
        input.imageCount ? `[${input.imageCount} image(s)]` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return [`  ${delivery.padEnd(9)} · `, preview];
    }),
    QUEUED_INPUT_VISIBLE_LIMIT,
    width,
    remaining(reserveScheduledRow ? 1 : 0),
  );

  if (scheduledInputSummary && (availableHeight === undefined || lines.length < availableHeight)) {
    const nextAt = formatClockTime(scheduledInputSummary.nextAt);
    lines.push(
      truncateToWidth(
        color(`Scheduled · ${scheduledInputSummary.count} · next ${nextAt}`, tuiTheme.command),
        width,
      ),
    );
  }

  lines.push(
    ...renderSection(
      `Your tasks · ${pendingUserTasks.length} · /task`,
      pendingUserTasks.map((task) => [`  ${task.id} · `, normalizeLabel(task.label)]),
      USER_TASK_VISIBLE_LIMIT,
      width,
      remaining(lines.length),
    ),
  );
  lines.push(
    ...renderSection(
      `Background · ${backgroundActivity.length}`,
      backgroundActivity.map((item) => [
        `  ${item.kind.padEnd(8)} · ${item.id} · ${item.status} · `,
        normalizeLabel(item.label),
      ]),
      BACKGROUND_ACTIVITY_VISIBLE_LIMIT,
      width,
      remaining(lines.length),
    ),
  );
  return lines;
}

export function renderMemoryActivity(activity: readonly MemoryConsolidationActivity[]): string {
  const organizing = ["project", "global"].filter((scope) =>
    activity.some((item) => item.scope === scope && item.status === "organizing"),
  );
  const queued = ["project", "global"].filter(
    (scope) => !organizing.includes(scope) && activity.some((item) => item.scope === scope),
  );
  return color(
    [
      "Memory",
      ...(organizing.length > 0 ? [`organizing ${organizing.join(" + ")}`] : []),
      ...(queued.length > 0 ? [`queued ${queued.join(" + ")}`] : []),
    ].join(" · "),
    tuiTheme.command,
  );
}

// One header row, then up to `visibleLimit` rows of muted prefix plus label.
// When rows overflow, the last detail row becomes a "… N more" marker.
function renderSection(
  title: string,
  rows: readonly (readonly [prefix: string, label: string])[],
  visibleLimit: number,
  width: number,
  availableHeight: number | undefined,
): string[] {
  if (rows.length === 0) {
    return [];
  }
  const maximumRows =
    availableHeight === undefined ? visibleLimit + 1 : Math.max(0, Math.floor(availableHeight));
  if (maximumRows <= 0) {
    return [];
  }
  const lines = [color(title, tuiTheme.command)];
  if (maximumRows === 1) {
    return lines;
  }
  const detailRows = Math.min(maximumRows - 1, visibleLimit);
  const overflow = rows.length > detailRows && detailRows > 1;
  const visibleCount = overflow ? detailRows - 1 : detailRows;
  for (const [prefix, label] of rows.slice(0, visibleCount)) {
    lines.push(
      truncateToWidth(
        `${color(prefix, tuiTheme.muted)}${color(label, tuiTheme.userMessageText)}`,
        width,
      ),
    );
  }
  if (overflow) {
    lines.push(dim(`  … ${rows.length - visibleCount} more`));
  }
  return lines;
}

function normalizeLabel(value: string): string {
  return stripTerminalControlSequences(value).replace(/\s+/g, " ").trim();
}

function formatClockTime(value: Date): string {
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}
