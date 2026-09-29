import { graphemeSegments } from "./graphemes";

export function summarizeText(value: string, maxLength = 80): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  const segments = graphemeSegments(normalized);

  if (segments.length <= maxLength) {
    return normalized;
  }

  const keepCount = Math.max(0, maxLength - 1);
  const endOffset = segments[keepCount]?.index ?? 0;
  return `${normalized.slice(0, endOffset)}…`;
}

export function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}
