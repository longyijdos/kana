import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getKanaConfigPaths } from "../config";
import type { LoadKanaSkillsOptions } from "./types";

export function loadEnabledGlobalSkillNames(globalSkillsDir: string): Set<string> {
  const configPath = path.join(globalSkillsDir, "skills.toml");

  if (!existsSync(configPath)) {
    return new Set();
  }

  const parsed = Bun.TOML.parse(readFileSync(configPath, "utf8")) as unknown;
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

  mkdirSync(globalSkillsDir, { recursive: true });
  writeFileSync(configPath, serializeSkillsConfig([...names]), {
    encoding: "utf8",
    mode: 0o600,
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
