import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { getKanaConfigPaths } from "../config";
import { encodeKanaWorkspacePath } from "../path";
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

export function readKanaRunAccounting(accountingPath: string): KanaRunAccountingRecord[] {
  if (!existsSync(accountingPath)) return [];
  return readFileSync(accountingPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const record = JSON.parse(line) as KanaRunAccountingRecord;
        return record.type === "run" && record.version === KANA_ACCOUNTING_VERSION ? [record] : [];
      } catch {
        return [];
      }
    });
}

function assertSessionId(sessionId: string): void {
  if (!sessionId || sessionId.includes("/") || sessionId.includes("\\")) {
    throw new Error("sessionId must be a non-empty file-name-safe string.");
  }
}
