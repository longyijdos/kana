import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  getKanaConfigPaths,
  type KanaMainAgentModelSelection,
  parseKanaConfig,
  type ResolvedKanaConfig,
} from "./config";

type UpdateKanaMainAgentOptions = {
  persist?: boolean;
  beforeCommit?(config: ResolvedKanaConfig): void;
};

export type KanaConfigStore = {
  load(): ResolvedKanaConfig;
  updateMainAgent(
    selection: KanaMainAgentModelSelection,
    options?: UpdateKanaMainAgentOptions,
  ): ResolvedKanaConfig;
};

export function createKanaConfigStore(env: NodeJS.ProcessEnv = process.env): KanaConfigStore {
  const { configPath, home } = getKanaConfigPaths(env);
  let transientDocument: string | undefined;
  const readDocument = (): string =>
    transientDocument ?? (existsSync(configPath) ? readFileSync(configPath, "utf8") : "");

  return {
    load() {
      return parseDocument(readDocument(), env);
    },
    updateMainAgent(selection, options = {}) {
      const currentDocument = readDocument();
      const current = parseDocument(currentDocument, env);
      const modelChanged =
        current.agent.model.provider !== selection.provider ||
        current.agent.model.model !== selection.model;
      let nextDocument = currentDocument;

      if (current.agent.model.provider !== selection.provider) {
        nextDocument = updateTomlField(nextDocument, "agent", "provider", selection.provider);
      }
      if (current.agent.model.model !== selection.model) {
        nextDocument = updateTomlField(nextDocument, "agent", "model", selection.model);
      }
      if (
        selection.reasoningEffort !== undefined &&
        (modelChanged || current.agent.model.reasoningEffort !== selection.reasoningEffort)
      ) {
        nextDocument = updateTomlField(
          nextDocument,
          "agent",
          "reasoning_effort",
          selection.reasoningEffort,
        );
      }

      const resolved = parseDocument(nextDocument, env);
      if (
        selection.reasoningEffort !== undefined &&
        resolved.agent.model.reasoningEffort !== selection.reasoningEffort
      ) {
        throw new Error(
          `${selection.provider}/${selection.model} does not expose reasoning effort ${selection.reasoningEffort}.`,
        );
      }
      options.beforeCommit?.(resolved);

      if (nextDocument === currentDocument) return current;
      if (options.persist === false) {
        transientDocument = nextDocument;
      } else {
        mkdirSync(home, { recursive: true });
        writeConfigAtomically(configPath, nextDocument);
      }
      return resolved;
    },
  };
}

function parseDocument(document: string, env: NodeJS.ProcessEnv): ResolvedKanaConfig {
  return parseKanaConfig(document ? (Bun.TOML.parse(document) as unknown) : {}, env);
}

function updateTomlField(document: string, section: string, key: string, value: string): string {
  const lines = document ? document.replace(/\r\n/g, "\n").split("\n") : [];
  while (lines.at(-1) === "") lines.pop();

  const sectionStart = findSection(lines, section);
  const sectionEnd =
    sectionStart === undefined ? undefined : findNextSection(lines, sectionStart + 1);
  const keyIndex =
    sectionStart === undefined
      ? undefined
      : findKey(lines, key, sectionStart + 1, sectionEnd ?? lines.length);
  const assignment = `${key} = ${JSON.stringify(value)}`;

  if (keyIndex !== undefined) {
    lines[keyIndex] = assignment;
  } else if (sectionStart !== undefined) {
    let insertionIndex = sectionEnd ?? lines.length;
    while (insertionIndex > sectionStart + 1 && lines[insertionIndex - 1]?.trim() === "") {
      insertionIndex -= 1;
    }
    lines.splice(insertionIndex, 0, assignment);
  } else {
    if (lines.length > 0) lines.push("");
    lines.push(`[${section}]`, assignment);
  }

  return `${lines.join("\n")}\n`;
}

function findSection(lines: string[], section: string): number | undefined {
  const pattern = new RegExp(`^\\s*\\[${escapeRegExp(section)}\\]\\s*(?:#.*)?$`);
  for (const [index, line] of lines.entries()) {
    if (pattern.test(line)) return index;
  }
  return undefined;
}

function findNextSection(lines: string[], start: number): number | undefined {
  for (let index = start; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index] ?? "")) return index;
  }
  return undefined;
}

function findKey(lines: string[], key: string, start: number, end: number): number | undefined {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  for (let index = start; index < end; index += 1) {
    if (pattern.test(lines[index] ?? "")) return index;
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeConfigAtomically(configPath: string, content: string): void {
  // A sibling temporary file keeps rename atomic on the target filesystem.
  const temporaryPath = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, configPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}
