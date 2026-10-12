export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Splits file content into lines, dropping the empty entry after a trailing newline.
export function splitContentLines(content: string): string[] {
  if (!content) {
    return [];
  }
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "" && /\r?\n$/.test(content)) {
    lines.pop();
  }
  return lines;
}
