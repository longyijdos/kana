import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { serializeKanaCustomProviderExample } from "../custom-provider";
import { getKanaConfigPaths } from "../path";
import { DEFAULT_KANA_TOOL_APPROVALS } from "../tool-approval-defaults";
import type { KanaConfig } from "./contracts";
import { DEFAULT_KANA_CONFIG } from "./defaults";
import { parseKanaConfig } from "./parser";
import { serializeKanaConfigExample } from "./reference";

export type InstallKanaConfigResult = {
  configPath: string;
  configStatus: "defaults" | "exists";
  configExamplePath: string;
  configExampleStatus: "created" | "exists" | "updated";
  mcpConfigPath: string;
  mcpConfigStatus: "created" | "exists";
  mcpEnabledPath: string;
  mcpEnabledStatus: "created" | "exists";
  approvalsPath: string;
  approvalsStatus: "created" | "exists";
  skillsConfigPath: string;
  skillsConfigStatus: "created" | "exists";
  customProviderExamplePath: string;
  customProviderExampleStatus: "created" | "exists" | "updated";
};

export type ResetKanaConfigResult = {
  configPath: string;
  configRemoved: boolean;
  configExamplePath: string;
  mcpConfigPath: string;
  mcpEnabledPath: string;
  approvalsPath: string;
  skillsConfigPath: string;
};

export function loadKanaConfig(env: NodeJS.ProcessEnv = process.env): KanaConfig {
  const { configPath } = getKanaConfigPaths(env);

  if (!existsSync(configPath)) {
    return structuredClone(DEFAULT_KANA_CONFIG);
  }

  const parsed = Bun.TOML.parse(readFileSync(configPath, "utf8")) as unknown;
  return parseKanaConfig(parsed);
}

export function installKanaConfig(env: NodeJS.ProcessEnv = process.env): InstallKanaConfigResult {
  const {
    home,
    configPath,
    configExamplePath,
    mcpConfigPath,
    mcpEnabledPath,
    approvalsPath,
    skillsConfigPath,
    providersDirectory,
    customProviderExamplePath,
  } = getKanaConfigPaths(env);
  mkdirSync(home, { recursive: true });
  mkdirSync(providersDirectory, { recursive: true });

  const configExists = existsSync(configPath);

  return {
    configPath,
    configStatus: configExists ? "exists" : "defaults",
    configExamplePath,
    configExampleStatus: writeGeneratedConfigExample(configExamplePath),
    mcpConfigPath,
    mcpConfigStatus: installKanaFile(
      mcpConfigPath,
      `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`,
    ),
    mcpEnabledPath,
    mcpEnabledStatus: installKanaFile(
      mcpEnabledPath,
      `${JSON.stringify({ enabledServers: [] }, null, 2)}\n`,
    ),
    approvalsPath,
    approvalsStatus: installKanaFile(
      approvalsPath,
      `${JSON.stringify(DEFAULT_KANA_TOOL_APPROVALS, null, 2)}\n`,
    ),
    skillsConfigPath,
    skillsConfigStatus: installKanaFile(skillsConfigPath, serializeEmptySkillsConfig()),
    customProviderExamplePath,
    customProviderExampleStatus: writeGeneratedExample(
      customProviderExamplePath,
      serializeKanaCustomProviderExample(),
    ),
  };
}

export function resetKanaConfig(env: NodeJS.ProcessEnv = process.env): ResetKanaConfigResult {
  const paths = getKanaConfigPaths(env);
  mkdirSync(paths.home, { recursive: true });

  // Reset touches only the explicit configuration allowlist. User data,
  // credentials, logs, AGENTS.md, and installed Skill directories stay intact.
  const configRemoved = existsSync(paths.configPath);
  rmSync(paths.configPath, { force: true });
  writeGeneratedConfigExample(paths.configExamplePath);
  writeKanaFile(paths.mcpConfigPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
  writeKanaFile(paths.mcpEnabledPath, `${JSON.stringify({ enabledServers: [] }, null, 2)}\n`);
  writeKanaFile(paths.approvalsPath, `${JSON.stringify(DEFAULT_KANA_TOOL_APPROVALS, null, 2)}\n`);
  writeKanaFile(paths.skillsConfigPath, serializeEmptySkillsConfig());

  return {
    configPath: paths.configPath,
    configRemoved,
    configExamplePath: paths.configExamplePath,
    mcpConfigPath: paths.mcpConfigPath,
    mcpEnabledPath: paths.mcpEnabledPath,
    approvalsPath: paths.approvalsPath,
    skillsConfigPath: paths.skillsConfigPath,
  };
}

function installKanaFile(filePath: string, content: string): "created" | "exists" {
  if (existsSync(filePath)) {
    return "exists";
  }

  writeKanaFile(filePath, content);
  return "created";
}

function writeGeneratedConfigExample(
  configExamplePath: string,
): InstallKanaConfigResult["configExampleStatus"] {
  const content = serializeKanaConfigExample(DEFAULT_KANA_CONFIG);
  return writeGeneratedExample(configExamplePath, content);
}

function writeGeneratedExample(
  filePath: string,
  content: string,
): "created" | "exists" | "updated" {
  if (!existsSync(filePath)) {
    writeKanaFile(filePath, content);
    return "created";
  }
  if (readFileSync(filePath, "utf8") === content) {
    return "exists";
  }

  // The example is generated reference material rather than user configuration,
  // so refreshing it is safe and keeps upgrades aligned with the current schema.
  writeKanaFile(filePath, content);
  return "updated";
}

function writeKanaFile(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
}

function serializeEmptySkillsConfig(): string {
  return ["[model_invocation]", "enabled = []", ""].join("\n");
}
