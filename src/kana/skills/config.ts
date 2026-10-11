import path from "node:path";
import { Type } from "typebox";
import { parseWithSchema } from "@/utils";

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

const SKILLS_CONFIG_SCHEMA = Type.Object({
  model_invocation: Type.Optional(
    Type.Object({ enabled: Type.Optional(Type.Array(Type.String())) }),
  ),
});

function parseEnabledGlobalSkillNames(content: string | undefined): Set<string> {
  if (content === undefined) {
    return new Set();
  }
  const config = parseWithSchema(SKILLS_CONFIG_SCHEMA, Bun.TOML.parse(content), "skills.toml");
  return new Set(config.model_invocation?.enabled);
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
