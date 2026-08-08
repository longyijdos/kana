const ALLOWED_HYPERLINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const WHITESPACE_PATTERN = /\s/;

export const CLOSE_TERMINAL_HYPERLINK = "\x1b]8;;\x1b\\";

export function sanitizeTerminalHyperlinkDestination(value: string): string | undefined {
  if (!value || WHITESPACE_PATTERN.test(value) || TERMINAL_CONTROL_PATTERN.test(value)) {
    return undefined;
  }

  try {
    const destination = new URL(value);
    return ALLOWED_HYPERLINK_SCHEMES.has(destination.protocol) ? destination.href : undefined;
  } catch {
    return undefined;
  }
}

export function terminalHyperlink(text: string, destination: string): string {
  const safeDestination = sanitizeTerminalHyperlinkDestination(destination);
  if (!safeDestination) {
    return text;
  }

  return `\x1b]8;;${safeDestination}\x1b\\${text}${CLOSE_TERMINAL_HYPERLINK}`;
}

export function terminalHyperlinkState(sequence: string): "open" | "closed" | undefined {
  const match = sequence.match(/^(?:\x1b]|\x9d)8;[^;]*;([\s\S]*?)(?:\x07|\x1b\\|\x9c)$/);

  if (!match) {
    return undefined;
  }

  return match[1] ? "open" : "closed";
}
