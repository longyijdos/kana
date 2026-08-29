import { type CreateCliOptions, createCli } from "../../src/cli";
import { KANA_VERSION } from "../../src/version";

export async function parseCli(argv: string[], options: Partial<CreateCliOptions>): Promise<void> {
  await createCli({
    ...defaultCliOptions(),
    ...options,
  }).parseAsync(argv);
}

export function defaultCliOptions(): CreateCliOptions {
  return {
    confirm: async () => true,
    installKanaConfig: defaultInstallResult,
    installKanaSkills: async () => ({
      skillsPath: "/tmp/.kana/skills/kana-skills",
      status: "cloned",
    }),
    isInteractive: () => true,
    reinstallKanaSkills: async () => ({
      skillsPath: "/tmp/.kana/skills/kana-skills",
      status: "reinstalled",
    }),
    resetKanaConfig: defaultResetResult,
    resyncKanaSkills: () => ({
      sourcePath: "/tmp/.kana/skills/kana-skills",
      targetName: "codex",
      targetPath: "/tmp/.codex/skills",
      skills: [],
    }),
    syncKanaSkills: () => ({
      sourcePath: "/tmp/.kana/skills/kana-skills",
      targetName: "codex",
      targetPath: "/tmp/.codex/skills",
      skills: [],
    }),
    log: () => {},
    startHeadless: async () => 0,
    startTui: () => {},
    updateKana: async () => ({
      status: "up-to-date",
      currentVersion: KANA_VERSION,
      latestVersion: KANA_VERSION,
    }),
  };
}

export function defaultInstallResult(): ReturnType<CreateCliOptions["installKanaConfig"]> {
  return {
    configPath: "/tmp/config.toml",
    configStatus: "defaults",
    configExamplePath: "/tmp/config.example.toml",
    configExampleStatus: "created",
    mcpConfigPath: "/tmp/mcp.json",
    mcpConfigStatus: "created",
    mcpEnabledPath: "/tmp/mcp-enabled.json",
    mcpEnabledStatus: "created",
    approvalsPath: "/tmp/approvals.json",
    approvalsStatus: "created",
    skillsConfigPath: "/tmp/skills.toml",
    skillsConfigStatus: "created",
    customProviderExamplePath: "/tmp/providers/custom.example.toml",
    customProviderExampleStatus: "created",
  };
}

export function defaultResetResult(): ReturnType<CreateCliOptions["resetKanaConfig"]> {
  return {
    configPath: "/tmp/config.toml",
    configRemoved: true,
    configExamplePath: "/tmp/config.example.toml",
    mcpConfigPath: "/tmp/mcp.json",
    mcpEnabledPath: "/tmp/mcp-enabled.json",
    approvalsPath: "/tmp/approvals.json",
    skillsConfigPath: "/tmp/skills.toml",
  };
}
