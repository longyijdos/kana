import path from "node:path";

import { getKanaConfigPaths } from "../path";
import { persistEnabledGlobalSkillNames } from "./config";
import { loadKanaSkillActivations } from "./loader";
import type { LoadKanaSkillActivationsResult, LoadKanaSkillsOptions } from "./types";

export type KanaSkillStore = {
  load(): LoadKanaSkillActivationsResult;
  saveEnabledGlobalNames(names: readonly string[]): LoadKanaSkillActivationsResult;
};

export function createKanaSkillStore(options: LoadKanaSkillsOptions = {}): KanaSkillStore {
  let snapshot = loadKanaSkillActivations(options);
  let enabledGlobalNames = readEnabledGlobalNames(snapshot);
  const { home } = getKanaConfigPaths(options.env);
  const configPath = path.join(home, "skills", "skills.toml");

  return {
    load: () => structuredClone(snapshot),
    saveEnabledGlobalNames(names) {
      const nextEnabledGlobalNames = [...new Set(names)];
      persistEnabledGlobalSkillNames(configPath, enabledGlobalNames, nextEnabledGlobalNames);
      const enabled = new Set(nextEnabledGlobalNames);
      snapshot = {
        skills: snapshot.skills.map((skill) => ({
          ...skill,
          enabled: skill.scope === "project" || enabled.has(skill.name),
        })),
        diagnostics: snapshot.diagnostics,
      };
      enabledGlobalNames = nextEnabledGlobalNames;
      return structuredClone(snapshot);
    },
  };
}

function readEnabledGlobalNames(snapshot: LoadKanaSkillActivationsResult): string[] {
  return snapshot.skills
    .filter((skill) => skill.scope === "global" && skill.enabled)
    .map((skill) => skill.name);
}
