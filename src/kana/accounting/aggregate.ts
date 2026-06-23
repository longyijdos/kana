import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { addModelUsage, type ModelUsage } from "@/core";
import { getKanaConfigPaths } from "../config";
import { encodeKanaWorkspacePath } from "../path";
import { getKanaAccountingPath, readKanaRunAccounting } from "./storage";
import type {
  KanaAccountingOutcome,
  KanaRunAccountingRecord,
  KanaUsageSummary,
  LoadKanaUsageSummaryOptions,
} from "./types";

export function loadKanaUsageSummary(options: LoadKanaUsageSummaryOptions): KanaUsageSummary {
  if (options.scope === "session" && !options.sessionId) {
    throw new Error("sessionId is required when loading session usage.");
  }
  return summarize(listAccountingPaths(options).flatMap(readKanaRunAccounting), options.scope);
}

function summarize(
  records: KanaRunAccountingRecord[],
  scope: KanaUsageSummary["scope"],
): KanaUsageSummary {
  const outcomes: Record<KanaAccountingOutcome, number> = {
    stop: 0,
    length: 0,
    aborted: 0,
    error: 0,
    updated: 0,
    unchanged: 0,
  };
  let usage: ModelUsage | undefined;
  let costCny = 0;
  let mainRunCount = 0;
  let memoryRunCount = 0;
  for (const record of records) {
    usage = record.usage ? addModelUsage(usage, record.usage) : usage;
    costCny += record.costCny;
    outcomes[record.outcome] += 1;
    if (record.agentKind === "main") mainRunCount += 1;
    else memoryRunCount += 1;
  }
  return {
    scope,
    runCount: records.length,
    mainRunCount,
    memoryRunCount,
    costCny,
    usage,
    outcomes,
  };
}

function listAccountingPaths(options: LoadKanaUsageSummaryOptions): string[] {
  if (options.scope === "session") return [getKanaAccountingPath(options.sessionId ?? "", options)];
  const root = getKanaConfigPaths(options.env).accountingPath;
  const workspace = encodeKanaWorkspacePath(options.cwd ?? process.cwd());
  const directories =
    options.scope === "project" ? [path.join(root, workspace)] : listDirectories(root);
  return directories.flatMap((directory) => listJsonlFiles(directory));
}

function listDirectories(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));
}

function listJsonlFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(directory, entry.name));
}
