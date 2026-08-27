import type { Logger, LogMetadata } from "@/logging";

export type RecordedLog = {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  metadata?: LogMetadata;
};

export function createRecordingLogger(records: RecordedLog[]): Logger {
  return {
    debug: (event, metadata) => records.push({ level: "debug", event, metadata }),
    info: (event, metadata) => records.push({ level: "info", event, metadata }),
    warn: (event, metadata) => records.push({ level: "warn", event, metadata }),
    error: (event, metadata) => records.push({ level: "error", event, metadata }),
  };
}
