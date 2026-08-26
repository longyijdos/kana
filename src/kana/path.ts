import { homedir } from "node:os";
import path from "node:path";

export type KanaConfigPaths = {
  home: string;
  configPath: string;
  configExamplePath: string;
  mcpConfigPath: string;
  mcpEnabledPath: string;
  agentsPath: string;
  memoryDirectory: string;
  sessionsPath: string;
  artifactsPath: string;
  logsPath: string;
  accountingPath: string;
  approvalsPath: string;
  skillsConfigPath: string;
  providersDirectory: string;
  customProviderPath: string;
  customProviderExamplePath: string;
};

export function getKanaConfigPaths(env: NodeJS.ProcessEnv = process.env): KanaConfigPaths {
  const home = env.KANA_HOME ?? path.join(env.HOME ?? homedir(), ".kana");

  return {
    home,
    configPath: path.join(home, "config.toml"),
    configExamplePath: path.join(home, "config.example.toml"),
    mcpConfigPath: path.join(home, "mcp.json"),
    mcpEnabledPath: path.join(home, "mcp-enabled.json"),
    agentsPath: path.join(home, "AGENTS.md"),
    memoryDirectory: path.join(home, "memory"),
    sessionsPath: path.join(home, "sessions"),
    artifactsPath: path.join(home, "artifacts"),
    logsPath: path.join(home, "logs"),
    accountingPath: path.join(home, "accounting"),
    approvalsPath: path.join(home, "approvals.json"),
    skillsConfigPath: path.join(home, "skills", "skills.toml"),
    providersDirectory: path.join(home, "providers"),
    customProviderPath: path.join(home, "providers", "custom.toml"),
    customProviderExamplePath: path.join(home, "providers", "custom.example.toml"),
  };
}

// Workspace-scoped Kana data must use one stable encoding so sessions,
// project memory, and runtime logs resolve to the same logical directory name.
export function encodeKanaWorkspacePath(cwd: string): string {
  return `--${path
    .resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
}

export type KanaLogPathOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export function getKanaSessionLogPath(sessionId: string, options: KanaLogPathOptions = {}): string {
  if (!sessionId || sessionId.includes("/") || sessionId.includes("\\")) {
    throw new Error("sessionId must be a non-empty file-name-safe string.");
  }

  return path.join(
    getKanaConfigPaths(options.env).logsPath,
    encodeKanaWorkspacePath(options.cwd ?? process.cwd()),
    `${sessionId}.jsonl`,
  );
}
