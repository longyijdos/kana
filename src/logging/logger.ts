import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export const LOG_LEVELS = ["debug", "info", "warn", "error", "off"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
type ActiveLogLevel = Exclude<LogLevel, "off">;
export type LogMetadata = Record<string, unknown>;

export type LogRecord = {
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
}

export type CreateSessionLoggerOptions = {
  path: string;
  sessionId: string;
  level: LogLevel;
  now?: () => Date;
};

export type SessionLogTarget = Pick<CreateSessionLoggerOptions, "path" | "sessionId">;

export type SessionLogManager = {
  forSession(target: SessionLogTarget): Logger;
};

export type CreateSessionLogManagerOptions = Pick<CreateSessionLoggerOptions, "level" | "now">;

const LOG_LEVEL_PRIORITY: Record<ActiveLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const SENSITIVE_KEY = /(?:api[_-]?key|authorization|cookie|password|secret|token)/i;
const MAX_STRING_LENGTH = 2_000;
const MAX_DEPTH = 5;

export function createNoopLogger(): Logger {
  return NOOP_LOGGER;
}

export function createSessionLogManager(
  options: CreateSessionLogManagerOptions,
): SessionLogManager {
  return {
    forSession(target) {
      return createSessionLogger({
        ...target,
        level: options.level,
        now: options.now,
      });
    },
  };
}

export function createSessionLogger(options: CreateSessionLoggerOptions): Logger {
  if (options.level === "off") {
    return NOOP_LOGGER;
  }

  return new SessionLogger(options as CreateActiveSessionLoggerOptions);
}

class SessionLogger implements Logger {
  private readonly now: () => Date;

  constructor(private readonly options: CreateActiveSessionLoggerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  debug(event: string, metadata?: LogMetadata): void {
    this.write("debug", event, metadata);
  }

  info(event: string, metadata?: LogMetadata): void {
    this.write("info", event, metadata);
  }

  warn(event: string, metadata?: LogMetadata): void {
    this.write("warn", event, metadata);
  }

  error(event: string, metadata?: LogMetadata): void {
    this.write("error", event, metadata);
  }

  private write(level: ActiveLogLevel, event: string, metadata?: LogMetadata): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.options.level]) {
      return;
    }

    try {
      const record: LogRecord = {
        timestamp: this.now().toISOString(),
        level,
        event,
        sessionId: this.options.sessionId,
        ...(metadata === undefined ? {} : { metadata: sanitizeLogMetadata(metadata) }),
      };
      mkdirSync(path.dirname(this.options.path), { recursive: true });
      appendFileSync(this.options.path, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // Logging is strictly diagnostic. I/O failures must never alter the runtime path.
    }
  }
}

type CreateActiveSessionLoggerOptions = Omit<CreateSessionLoggerOptions, "level"> & {
  level: ActiveLogLevel;
};

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

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
