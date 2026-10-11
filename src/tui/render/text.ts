import { graphemeSegments } from "./graphemes";
import { stripTerminalControlSequences } from "./width";

export function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

// Untrusted labels (server names, job labels, messages) shown on one row.
export function singleLine(value: string): string {
  return collapseWhitespace(stripTerminalControlSequences(value));
}

export function summarizeText(value: string, maxLength = 80): string {
  const normalized = collapseWhitespace(value);
  const segments = graphemeSegments(normalized);

  if (segments.length <= maxLength) {
    return normalized;
  }

  const keepCount = Math.max(0, maxLength - 1);
  const endOffset = segments[keepCount]?.index ?? 0;
  return `${normalized.slice(0, endOffset)}…`;
}

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

export function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export function formatByteSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function base64ByteLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

export function setsEqual(first: ReadonlySet<string>, second: ReadonlySet<string>): boolean {
  return first.size === second.size && [...first].every((value) => second.has(value));
}
