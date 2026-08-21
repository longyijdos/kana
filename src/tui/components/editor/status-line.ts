import { color, dim, truncateToWidth } from "../../render";
import { tuiTheme } from "../../theme";

export type StatusLineState = {
  phase: string;
  activeTool?: string;
  cleanMode?: boolean;
  contextUsedPercent?: number;
  running: boolean;
};

export function renderStatusLine(
  width: number,
  model: string | undefined,
  state: StatusLineState,
): string {
  const parts = [
    model ? color(model, tuiTheme.model) : undefined,
    state.cleanMode ? color("Clean", tuiTheme.command) : undefined,
    state.contextUsedPercent === undefined
      ? undefined
      : color(`Context ~${state.contextUsedPercent}% used`, tuiTheme.contextUsage),
    phaseText(state.phase),
    state.activeTool ? color(`Tool ${state.activeTool}`, tuiTheme.toolActive) : undefined,
    color(formatCwd(process.cwd()), tuiTheme.cwd),
  ].filter((part): part is string => Boolean(part));

  return truncateToWidth(parts.join(dim(" | ")), width, "");
}

function phaseText(phase: string): string {
  const text = phase === "turn_limit" ? "Turn limit" : capitalizeFirst(phase);

  switch (phase) {
    case "error":
    case "aborted":
    case "length":
      return color(text, tuiTheme.error);
    case "turn_limit":
      return color(text, tuiTheme.error);
    case "starting":
    case "compacting":
    case "working":
    case "searching":
    case "responding":
    case "tool":
      return color(text, tuiTheme.toolActive);
    default:
      return color(text, tuiTheme.statusIdle);
  }
}

function capitalizeFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME;

  if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
    return `~${cwd.slice(home.length)}`;
  }

  return cwd;
}
