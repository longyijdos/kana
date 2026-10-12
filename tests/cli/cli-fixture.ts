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
    startServer: async () => {},
    startTui: () => {},
    updateKana: async () => ({
      status: "up-to-date",
      currentVersion: KANA_VERSION,
      latestVersion: KANA_VERSION,
    }),
  };
}

export function defaultInstallResult(): ReturnType<CreateCliOptions["installKanaConfig"]> {
  return [
    { name: "config example", path: "/tmp/config.example.toml", status: "created" },
    { name: "MCP config", path: "/tmp/mcp.json", status: "created" },
  ];
}

export function defaultResetResult(): ReturnType<CreateCliOptions["resetKanaConfig"]> {
  return {
    configPath: "/tmp/config.toml",
    configRemoved: true,
    resetFiles: [
      { name: "config example", path: "/tmp/config.example.toml" },
      { name: "MCP config", path: "/tmp/mcp.json" },
      { name: "MCP activation state", path: "/tmp/mcp-enabled.json" },
      { name: "approvals", path: "/tmp/approvals.json" },
      { name: "skills config", path: "/tmp/skills.toml" },
    ],
  };
}
