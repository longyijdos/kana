import { color, dim, truncateToWidth } from "../render";
import type { Component } from "../runtime";
import { tuiTheme } from "../theme";

export type StatusLineState = {
  phase: string;
  activeTool?: string;
  contextUsedPercent?: number;
  running: boolean;
};

export class StatusLine implements Component {
  private state: StatusLineState = {
    phase: "idle",
    running: false,
  };

  constructor(private readonly model: string) {}

  update(state: Partial<StatusLineState>): void {
    this.state = {
      ...this.state,
      ...state,
    };
  }

  render(width: number): string[] {
    const parts = [
      color(this.model, tuiTheme.model),
      this.state.contextUsedPercent === undefined
        ? undefined
        : dim(`Context ${this.state.contextUsedPercent}% used`),
      phaseText(this.state.phase),
      this.state.activeTool
        ? color(`tool ${this.state.activeTool}`, tuiTheme.toolActive)
        : undefined,
      color(formatCwd(process.cwd()), tuiTheme.cwd),
    ].filter((part): part is string => Boolean(part));

    return [truncateToWidth(parts.join(dim(" | ")), width, "")];
  }
}

function phaseText(phase: string): string {
  switch (phase) {
    case "error":
    case "aborted":
    case "length":
      return color(phase, tuiTheme.error);
    case "starting":
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
