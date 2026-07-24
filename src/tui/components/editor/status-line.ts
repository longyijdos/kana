import { color, dim, truncateToWidth } from "../../render";
import { tuiTheme } from "../../theme";

export type StatusLineState = {
  phase: string;
  activeTool?: string;
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
    state.contextUsedPercent === undefined
      ? undefined
      : color(`Context ${state.contextUsedPercent}% used`, tuiTheme.contextUsage),
    phaseText(state.phase),
    state.activeTool ? color(`tool ${state.activeTool}`, tuiTheme.toolActive) : undefined,
    color(formatCwd(process.cwd()), tuiTheme.cwd),
  ].filter((part): part is string => Boolean(part));

  return truncateToWidth(parts.join(dim(" | ")), width, "");
}

function phaseText(phase: string): string {
  switch (phase) {
    case "error":
    case "aborted":
    case "length":
      return color(phase, tuiTheme.error);
    case "turn_limit":
      return color("turn limit", tuiTheme.error);
    case "starting":
    case "compacting":
    case "thinking":
    case "responding":
    case "tool":
      return color(phase, tuiTheme.toolActive);
    default:
      return color(phase, tuiTheme.statusIdle);
  }
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME;

  if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
    return `~${cwd.slice(home.length)}`;
  }

  return cwd;
}
