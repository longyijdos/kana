import { createLogger, type Logger, type LogMetadata } from "@/logging";

export type RecordedLog = {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  metadata?: LogMetadata;
};

export function createRecordingLogger(records: RecordedLog[]): Logger {
  return createLogger((level, event, metadata) => records.push({ level, event, metadata }));
}
