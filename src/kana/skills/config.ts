import path from "node:path";

import {
  mergeConfigStringSet,
  readOptionalConfigFile,
  withLockedConfigFile,
  writeConfigFileAtomically,
} from "../config/file-storage";
import { getKanaConfigPaths } from "../path";
import type { LoadKanaSkillsOptions } from "./types";

export function loadEnabledGlobalSkillNames(globalSkillsDir: string): Set<string> {
  const configPath = path.join(globalSkillsDir, "skills.toml");

  return parseEnabledGlobalSkillNames(readOptionalConfigFile(configPath));
}

function parseEnabledGlobalSkillNames(content: string | undefined): Set<string> {
  if (content === undefined) {
    return new Set();
  }

  const parsed = Bun.TOML.parse(content) as unknown;
  const raw = asRecord(parsed, "skills config");
  const modelInvocation =
    raw.model_invocation === undefined ? {} : asRecord(raw.model_invocation, "model_invocation");
  const enabled = modelInvocation.enabled;

  if (enabled === undefined) {
    return new Set();
  }

  if (!Array.isArray(enabled)) {
    throw new Error("Invalid skills.toml: model_invocation.enabled must be an array");
  }

  return new Set(
    enabled.map((value, index) => {
      if (typeof value !== "string") {
        throw new Error(`Invalid skills.toml: model_invocation.enabled[${index}] must be a string`);
      }

      return value;
    }),
  );
}

export function saveEnabledGlobalSkillNames(
  names: Iterable<string>,
  options: Pick<LoadKanaSkillsOptions, "env"> = {},
): void {
  const { home } = getKanaConfigPaths(options.env);
  const globalSkillsDir = path.join(home, "skills");
  const configPath = path.join(globalSkillsDir, "skills.toml");
  const previous = [...loadEnabledGlobalSkillNames(globalSkillsDir)];

  persistEnabledGlobalSkillNames(configPath, previous, [...names]);
}

export function persistEnabledGlobalSkillNames(
  configPath: string,
  previousSnapshot: readonly string[],
  nextSnapshot: readonly string[],
): void {
  withLockedConfigFile(configPath, () => {
    const persisted = [...parseEnabledGlobalSkillNames(readOptionalConfigFile(configPath))];
    const merged = mergeConfigStringSet(persisted, previousSnapshot, nextSnapshot);
    writeConfigFileAtomically(configPath, serializeSkillsConfig(merged));
  });
}

function serializeSkillsConfig(enabledNames: string[]): string {
  const enabled = enabledNames.map((name) => JSON.stringify(name)).join(", ");

  return ["[model_invocation]", `enabled = [${enabled}]`, ""].join("\n");
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid skills.toml: ${label} must be a table`);
  }

  return value as Record<string, unknown>;
}
