import { color, dim } from "../render/ansi";
import type { Component } from "../runtime/component";
import { truncateToWidth } from "../render/width";

export type StatusLineState = {
  phase: string;
  turn?: number;
  maxTurns?: number;
  activeTool?: string;
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
    const turn =
      this.state.turn === undefined
        ? undefined
        : `turn ${this.state.turn}${
            this.state.maxTurns ? `/${this.state.maxTurns}` : ""
          }`;
    const parts = [
      color(this.model, "cyan"),
      phaseText(this.state.phase),
      turn,
      this.state.activeTool
        ? color(`tool ${this.state.activeTool}`, "yellow")
        : undefined,
      color(formatCwd(process.cwd()), "green"),
      dim(this.state.running ? "Esc abort" : "Ctrl+C exit"),
    ].filter((part): part is string => Boolean(part));

    return [truncateToWidth(parts.join(dim(" | ")), width, "")];
  }
}

function phaseText(phase: string): string {
  switch (phase) {
    case "error":
    case "aborted":
    case "length":
      return color(phase, "red");
    case "starting":
    case "thinking":
    case "responding":
    case "tool":
      return color(phase, "yellow");
    default:
      return color(phase, "white");
  }
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME;

  if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
    return `~${cwd.slice(home.length)}`;
  }

  return cwd;
}

