import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { MODEL_USAGE_SCHEMA } from "@/core";
import type { Logger } from "@/logging";
import { isRecord, parseWithSchema } from "@/utils";

import { encodeKanaWorkspacePath, getKanaConfigPaths } from "../path";
import {
  type AppendKanaRunAccountingOptions,
  KANA_ACCOUNTING_VERSION,
  type KanaRunAccountingRecord,
} from "./types";

export function getKanaAccountingPath(
  sessionId: string,
  options: AppendKanaRunAccountingOptions = {},
): string {
  assertSessionId(sessionId);
  return path.join(
    getKanaConfigPaths(options.env).accountingPath,
    encodeKanaWorkspacePath(options.cwd ?? process.cwd()),
    `${sessionId}.jsonl`,
  );
}

export function appendKanaRunAccounting(
  record: Omit<KanaRunAccountingRecord, "type" | "version" | "id" | "recordedAt"> & {
    id?: string;
    recordedAt?: string;
  },
  options: AppendKanaRunAccountingOptions = {},
): KanaRunAccountingRecord {
  assertSessionId(record.sessionId);
  const complete: KanaRunAccountingRecord = {
    type: "run",
    version: KANA_ACCOUNTING_VERSION,
    id: record.id ?? `run_${randomUUID()}`,
    recordedAt: record.recordedAt ?? new Date().toISOString(),
    ...record,
  };
  const accountingPath = getKanaAccountingPath(complete.sessionId, options);
  mkdirSync(path.dirname(accountingPath), { recursive: true });
  appendFileSync(accountingPath, `${JSON.stringify(complete)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return complete;
}

const RUN_RECORD_SCHEMA = Type.Object({
  type: Type.Literal("run"),
  version: Type.Literal(KANA_ACCOUNTING_VERSION),
  id: Type.String(),
  recordedAt: Type.String(),
  sessionId: Type.String(),
  agentKind: Type.Enum(["main", "memory_consolidation", "subagent"]),
  outcome: Type.Enum(["stop", "length", "aborted", "error", "turn_limit", "updated", "unchanged"]),
  model: Type.Object({ provider: Type.String(), model: Type.String() }),
  usage: Type.Optional(MODEL_USAGE_SCHEMA),
  assistantMessageCount: Type.Integer({ minimum: 0 }),
  memoryScope: Type.Optional(Type.Enum(["global", "project"])),
  memoryMode: Type.Optional(Type.Enum(["incremental", "full"])),
  memoryOrigin: Type.Optional(Type.Enum(["automatic", "manual"])),
});

// Records from other accounting versions are skipped silently; malformed
// records are logged and skipped so one bad line cannot hide the rest.
export function readKanaRunAccounting(
  accountingPath: string,
  logger?: Logger,
): KanaRunAccountingRecord[] {
  if (!existsSync(accountingPath)) return [];
  return readFileSync(accountingPath, "utf8")
    .split("\n")
    .flatMap((line, index) => {
      if (!line) return [];
      try {
        const record: unknown = JSON.parse(line);
        if (isRecord(record) && record.version !== KANA_ACCOUNTING_VERSION) return [];
        return [parseWithSchema(RUN_RECORD_SCHEMA, record, "accounting record")];
      } catch (error) {
        logger?.warn("accounting.record_skipped", {
          path: accountingPath,
          line: index + 1,
          error,
        });
        return [];
      }
    });
}

function assertSessionId(sessionId: string): void {
  if (!sessionId || sessionId.includes("/") || sessionId.includes("\\")) {
    throw new Error("sessionId must be a non-empty file-name-safe string.");
  }
}
