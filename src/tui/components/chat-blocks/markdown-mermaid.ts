import { type Cls, render, type Span } from "grok-mermaid";

import { bold, type Color, color } from "../../render";
import { tuiTheme } from "../../theme";

export type MarkdownMermaidResult =
  | { kind: "rendered"; lines: string[] }
  | { kind: "fallback"; warning?: string };

type MarkdownMermaidOptions = {
  color?: Color;
  complete: boolean;
};

export function renderMarkdownMermaid(
  source: string,
  availableWidth: number,
  options: MarkdownMermaidOptions,
): MarkdownMermaidResult {
  let art: ReturnType<typeof render>;

  try {
    art = render(source);
  } catch {
    // Mermaid source is model-generated and may exercise unsupported parser
    // paths. Rendering failures must never break the surrounding transcript.
    return { kind: "fallback" };
  }

  if (!art || art.width > Math.max(1, availableWidth)) {
    return { kind: "fallback" };
  }

  if (options.complete && art.warnings.length > 0) {
    return {
      kind: "fallback",
      warning: formatMermaidWarning(art.warnings),
    };
  }

  return {
    kind: "rendered",
    lines: art.styled.map((row) =>
      row.map((span) => styleMermaidSpan(span, options.color)).join(""),
    ),
  };
}

const MERMAID_SPAN_COLORS = {
  border: tuiTheme.markdownRule,
  edge: tuiTheme.markdownHeading,
  edgeLabel: tuiTheme.markdownQuote,
  title: tuiTheme.markdownHeading,
} satisfies Record<Exclude<Cls, "none" | "text">, Color>;

function styleMermaidSpan(span: Span, textColor: Color | undefined): string {
  if (span.cls === "none") {
    return span.text;
  }

  const styled = color(
    span.text,
    span.cls === "text" ? (textColor ?? tuiTheme.markdownText) : MERMAID_SPAN_COLORS[span.cls],
  );

  return span.cls === "title" ? bold(styled) : styled;
}

function formatMermaidWarning(warnings: string[]): string {
  const remaining = warnings.length - 1;
  const summary = remaining > 0 ? ` (${remaining} additional warnings)` : "";

  return `Mermaid source restored: ${warnings[0]}${summary}`;
}
