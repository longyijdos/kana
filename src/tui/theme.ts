import type { Color } from "./render/ansi";

export const tuiTheme = {
  assistant: "white",
  user: "cyan",
  prompt: "yellow",
  command: "magenta",
  commandSelected: "magenta",
  muted: "gray",
  model: "blue",
  cwd: "gray",
  toolActive: "yellow",
  toolSuccess: "green",
  toolOutput: "gray",
  error: "red",
  statusIdle: "white",
} satisfies Record<string, Color>;
