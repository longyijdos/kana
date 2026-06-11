import type { Color } from "./render";

export const tuiTheme = {
  assistant: "white",
  markdownText: "white",
  markdownHeading: "cyan",
  markdownQuote: "gray",
  markdownRule: "gray",
  markdownTable: "white",
  markdownCodeBlock: "white",
  markdownInlineCode: "yellow",
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
