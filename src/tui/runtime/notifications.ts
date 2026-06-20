import type { KanaNotificationBackend } from "@/kana";

export type TerminalNotification = {
  title: string;
  body?: string;
  urgency: "normal" | "critical";
};

export function resolveNotificationBackend(
  backend: KanaNotificationBackend,
  env: NodeJS.ProcessEnv = process.env,
): Exclude<KanaNotificationBackend, "auto"> {
  if (backend !== "auto") {
    return backend;
  }

  if (env.KITTY_WINDOW_ID) {
    return "kitty";
  }

  if (env.TERM_PROGRAM === "iTerm.app") {
    return "osc9";
  }

  if (env.VTE_VERSION) {
    return "osc777";
  }

  return "bell";
}

export function encodeTerminalNotification(
  notification: TerminalNotification,
  backend: Exclude<KanaNotificationBackend, "auto">,
  id = 1,
): string | undefined {
  switch (backend) {
    case "off":
      return undefined;
    case "bell":
      return "\x07";
    case "osc9":
      return encodeOsc9Notification(notification);
    case "osc777":
      return encodeOsc777Notification(notification);
    case "kitty":
      return encodeKittyNotification(notification, id);
  }
}

export function sanitizeTerminalNotificationText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function encodeOsc9Notification(notification: TerminalNotification): string {
  return `\x1b]9;${formatNotificationMessage(notification)}\x1b\\`;
}

function encodeOsc777Notification(notification: TerminalNotification): string {
  const title = sanitizeOsc777Field(notification.title);
  const body = sanitizeOsc777Field(notification.body ?? "");

  return `\x1b]777;notify;${title};${body}\x1b\\`;
}

function encodeKittyNotification(notification: TerminalNotification, id: number): string {
  const title = sanitizeTerminalNotificationText(notification.title);
  const body = notification.body ? sanitizeTerminalNotificationText(notification.body) : undefined;

  if (!body) {
    return `\x1b]99;;${title}\x1b\\`;
  }

  return `\x1b]99;i=${id}:d=0;${title}\x1b\\\x1b]99;i=${id}:p=body;${body}\x1b\\`;
}

function formatNotificationMessage(notification: TerminalNotification): string {
  const title = sanitizeTerminalNotificationText(notification.title);
  const body = notification.body ? sanitizeTerminalNotificationText(notification.body) : "";

  return body ? `${title}: ${body}` : title;
}

function sanitizeOsc777Field(value: string): string {
  return sanitizeTerminalNotificationText(value).replaceAll(";", ",");
}
