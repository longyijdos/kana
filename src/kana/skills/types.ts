export type KanaSkill = {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
};

export type KanaSkillDiagnostic =
  | {
      type: "warning";
      code: "read_failed" | "parse_failed" | "invalid_metadata";
      message: string;
      path: string;
    }
  | {
      type: "collision";
      code: "name_collision";
      message: string;
      path: string;
      winnerPath: string;
    };

export type LoadKanaSkillsOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  includeDefaults?: boolean;
  skillPaths?: string[];
};

export type LoadKanaSkillsResult = {
  skills: KanaSkill[];
  diagnostics: KanaSkillDiagnostic[];
};

export type KanaSkillActivation = KanaSkill & {
  scope: "project" | "global";
  enabled: boolean;
  mutable: boolean;
};

export type LoadKanaSkillActivationsResult = {
  skills: KanaSkillActivation[];
  diagnostics: KanaSkillDiagnostic[];
};

export type SkillFrontmatter = {
  name?: string;
  description?: string;
};
