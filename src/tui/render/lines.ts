export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function splitLines(value: string): string[] {
  return value.split(/\r\n|\r|\n/);
}

export function isLineBreak(value: string): boolean {
  return value === "\n" || value === "\r" || value === "\r\n";
}

export function mapLines(value: string, transform: (line: string) => string): string[] {
  return splitLines(value).map((line) => transform(line));
}

export function tailLines(value: string, limit: number): string {
  const lines = splitLines(value.trimEnd());
  const visible = lines.slice(-limit);
  const hidden = lines.length - visible.length;

  return hidden > 0 ? `... ${hidden} more lines\n${visible.join("\n")}` : visible.join("\n");
}
