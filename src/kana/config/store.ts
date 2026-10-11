import { getKanaConfigPaths } from "../path";
import type { KanaConfig, KanaConfigDraft } from "./contracts";
import {
  readOptionalConfigFile,
  withLockedConfigFile,
  writeConfigFileAtomically,
} from "./file-storage";
import { applyKanaConfigOverrides } from "./overrides";
import { listKanaConfigLeaves, parseKanaConfig, validateKanaConfig } from "./parser";
import { loadKanaConfig } from "./persistence";

type KanaConfigValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | undefined;

export type KanaConfigStore = {
  load(): KanaConfig;
  update(mutate: (draft: KanaConfigDraft) => void): KanaConfig;
};

// Updates patch only the changed TOML leaves so user comments and layout
// survive instead of serializing every default.
const CONFIG_LEAVES = listKanaConfigLeaves();

export function createKanaConfigStore(
  env: NodeJS.ProcessEnv = process.env,
  overrides: readonly string[] = [],
): KanaConfigStore {
  let snapshot = applyKanaConfigOverrides(loadKanaConfig(env), overrides);

  return {
    load: () => snapshot,
    update(mutate) {
      const current = snapshot;
      const draft = structuredClone(current) as KanaConfigDraft;
      mutate(draft);
      const next = validateKanaConfig(draft);
      const changedLeaves = CONFIG_LEAVES.filter(
        (leaf) => !sameConfigValue(readLeaf(current, leaf), readLeaf(next, leaf)),
      );
      if (changedLeaves.length === 0) {
        return current;
      }

      const { configPath } = getKanaConfigPaths(env);
      withLockedConfigFile(configPath, () => {
        let document = readOptionalConfigFile(configPath) ?? "";
        for (const leaf of changedLeaves) {
          document = updateTomlField(document, leaf.section, leaf.key, readLeaf(next, leaf));
        }

        // The line-based patch cannot handle every TOML layout, such as inline
        // or dotted-key tables, so confirm it produced the intended values.
        const persisted = parseKanaConfig(Bun.TOML.parse(document) as unknown);
        if (
          changedLeaves.some(
            (leaf) => !sameConfigValue(readLeaf(persisted, leaf), readLeaf(next, leaf)),
          )
        ) {
          throw new Error(
            "Kana could not safely update this config.toml layout. Normalize the affected tables and try again.",
          );
        }

        writeConfigFileAtomically(configPath, document);
      });
      snapshot = next;
      return snapshot;
    },
  };
}

function readLeaf(config: KanaConfig, leaf: { fieldPath: readonly string[] }): KanaConfigValue {
  let value: unknown = config;
  for (const key of leaf.fieldPath) {
    value = (value as Record<string, unknown> | undefined)?.[key];
  }
  return value as KanaConfigValue;
}

function sameConfigValue(left: KanaConfigValue, right: KanaConfigValue): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return left === right;
  }
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function updateTomlField(
  document: string,
  section: string,
  key: string,
  value: KanaConfigValue,
): string {
  const lines = document ? document.replace(/\r\n/g, "\n").split("\n") : [];
  while (lines.at(-1) === "") {
    lines.pop();
  }

  const sectionStart = findSection(lines, section);
  const sectionEnd =
    sectionStart === undefined ? undefined : findNextSection(lines, sectionStart + 1);
  const keyIndex =
    sectionStart === undefined
      ? undefined
      : findKey(lines, key, sectionStart + 1, sectionEnd ?? lines.length);

  if (value === undefined) {
    if (keyIndex !== undefined) {
      lines.splice(keyIndex, 1);
    }
    return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  }

  const assignment = `${key} = ${formatTomlValue(value)}`;
  if (keyIndex !== undefined) {
    lines[keyIndex] = assignment;
  } else if (sectionStart !== undefined) {
    let insertionIndex = sectionEnd ?? lines.length;
    while (insertionIndex > sectionStart + 1 && lines[insertionIndex - 1]?.trim() === "") {
      insertionIndex -= 1;
    }
    lines.splice(insertionIndex, 0, assignment);
  } else {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`[${section}]`, assignment);
  }

  return `${lines.join("\n")}\n`;
}

function findSection(lines: string[], section: string): number | undefined {
  const pattern = new RegExp(`^\\s*\\[${escapeRegExp(section)}\\]\\s*(?:#.*)?$`);
  for (const [index, line] of lines.entries()) {
    if (pattern.test(line)) {
      return index;
    }
  }
  return undefined;
}

function findNextSection(lines: string[], start: number): number | undefined {
  for (let index = start; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index] ?? "")) {
      return index;
    }
  }
  return undefined;
}

function findKey(lines: string[], key: string, start: number, end: number): number | undefined {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  for (let index = start; index < end; index += 1) {
    if (pattern.test(lines[index] ?? "")) {
      return index;
    }
  }
  return undefined;
}

function formatTomlValue(value: Exclude<KanaConfigValue, undefined>): string {
  if (typeof value === "string" || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return String(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
