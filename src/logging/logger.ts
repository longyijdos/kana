import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export const LOG_LEVELS = ["debug", "info", "warn", "error", "off"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
type ActiveLogLevel = Exclude<LogLevel, "off">;
export type LogMetadata = Record<string, unknown>;

type LogRecord = {
  timestamp: string;
  level: ActiveLogLevel;
  event: string;
  sessionId: string;
  metadata?: LogMetadata;
};

export interface Logger {
  debug(event: string, metadata?: LogMetadata): void;
  info(event: string, metadata?: LogMetadata): void;
  warn(event: string, metadata?: LogMetadata): void;
  error(event: string, metadata?: LogMetadata): void;
  // Returns a logger that adds `metadata` to every record it writes.
  child(metadata: LogMetadata): Logger;
}

export type LogWriter = (level: ActiveLogLevel, event: string, metadata?: LogMetadata) => void;

export type CreateSessionLoggerOptions = {
  path: string;
  sessionId: string;
  level: LogLevel;
  now?: () => Date;
};

const LOG_LEVEL_PRIORITY: Record<ActiveLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const SENSITIVE_KEY = /(?:api[_-]?key|authorization|cookie|password|secret|token)/i;
const MAX_STRING_LENGTH = 2_000;
const MAX_DEPTH = 5;

export function createLogger(write: LogWriter): Logger {
  return {
    debug: (event, metadata) => write("debug", event, metadata),
    info: (event, metadata) => write("info", event, metadata),
    warn: (event, metadata) => write("warn", event, metadata),
    error: (event, metadata) => write("error", event, metadata),
    child: (bound) =>
      createLogger((level, event, metadata) => write(level, event, { ...bound, ...metadata })),
  };
}

const NOOP_LOGGER: Logger = createLogger(() => {});

export function createNoopLogger(): Logger {
  return NOOP_LOGGER;
}

export function createSessionLogger(options: CreateSessionLoggerOptions): Logger {
  const { level: minimumLevel } = options;
  if (minimumLevel === "off") {
    return NOOP_LOGGER;
  }
  const now = options.now ?? (() => new Date());

  return createLogger((level, event, metadata) => {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[minimumLevel]) {
      return;
    }
    const record: LogRecord = {
      timestamp: now().toISOString(),
      level,
      event,
      sessionId: options.sessionId,
      ...(metadata === undefined || Object.keys(metadata).length === 0
        ? {}
        : { metadata: sanitizeLogMetadata(metadata) }),
    };
    try {
      mkdirSync(path.dirname(options.path), { recursive: true });
      appendFileSync(options.path, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // Logging is strictly diagnostic. I/O failures must never alter the runtime path.
    }
  });
}

function sanitizeLogMetadata(metadata: LogMetadata): LogMetadata {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeLogValue(value),
    ]),
  );
}

function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncate(value.message),
      ...(value.stack === undefined ? {} : { stack: truncate(value.stack) }),
    };
  }

  if (typeof value === "string") {
    return truncate(value);
  }

  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    return "[TRUNCATED]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item, depth + 1));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeLogValue(nestedValue, depth + 1),
      ]),
    );
  }

  return truncate(String(value));
}

function truncate(value: string): string {
  return value.length <= MAX_STRING_LENGTH ? value : `${value.slice(0, MAX_STRING_LENGTH)}…`;
}
