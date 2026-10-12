import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { writeFileAtomic } from "@/utils";
import { serializeKanaCustomProviderExample } from "../custom-provider";
import { getKanaConfigPaths } from "../path";
import { DEFAULT_KANA_TOOL_APPROVALS } from "../tool-approval-defaults";
import type { KanaConfig } from "./contracts";
import { DEFAULT_KANA_CONFIG } from "./defaults";
import { parseKanaConfig } from "./parser";
import {
  serializeKanaConfigExample,
  serializeKanaPromptTemplateExample,
  serializeKanaSubagentProfileExample,
} from "./reference";

export type KanaInstalledFile = {
  readonly name: string;
  readonly path: string;
  readonly status: "created" | "exists" | "updated";
};

export type ResetKanaConfigResult = {
  readonly configPath: string;
  readonly configRemoved: boolean;
  readonly resetFiles: readonly { readonly name: string; readonly path: string }[];
};

export function loadKanaConfig(env: NodeJS.ProcessEnv = process.env): KanaConfig {
  const { configPath } = getKanaConfigPaths(env);

  if (!existsSync(configPath)) {
    return DEFAULT_KANA_CONFIG;
  }

  const parsed = Bun.TOML.parse(readFileSync(configPath, "utf8")) as unknown;
  return parseKanaConfig(parsed);
}

// Creates missing support files and refreshes generated examples. config.toml
// itself is never created; it is reported only when the user already has one.
export function installKanaConfig(env: NodeJS.ProcessEnv = process.env): KanaInstalledFile[] {
  const paths = getKanaConfigPaths(env);
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.agentsDirectory, { recursive: true });
  mkdirSync(paths.providersDirectory, { recursive: true });

  const generated = (name: string, filePath: string, content: string): KanaInstalledFile => ({
    name,
    path: filePath,
    status: writeGeneratedExample(filePath, content),
  });
  const installed = (name: string, filePath: string, content: string): KanaInstalledFile => ({
    name,
    path: filePath,
    status: installKanaFile(filePath, content),
  });

  return [
    ...(existsSync(paths.configPath)
      ? [{ name: "config", path: paths.configPath, status: "exists" as const }]
      : []),
    generated("config example", paths.configExamplePath, configExample()),
    installed("MCP config", paths.mcpConfigPath, EMPTY_MCP_CONFIG),
    installed("MCP activation state", paths.mcpEnabledPath, EMPTY_MCP_ACTIVATION),
    installed("approvals", paths.approvalsPath, defaultApprovals()),
    installed("skills config", paths.skillsConfigPath, EMPTY_SKILLS_CONFIG),
    generated(
      "subagent profile example",
      paths.subagentProfileExamplePath,
      serializeKanaSubagentProfileExample(),
    ),
    generated(
      "prompt template example",
      paths.promptTemplateExamplePath,
      serializeKanaPromptTemplateExample(),
    ),
    generated(
      "Custom provider example",
      paths.customProviderExamplePath,
      serializeKanaCustomProviderExample(),
    ),
  ];
}

// Reset touches only the explicit configuration allowlist. User data,
// credentials, logs, AGENTS.md, and installed Skill directories stay intact.
export function resetKanaConfig(env: NodeJS.ProcessEnv = process.env): ResetKanaConfigResult {
  const paths = getKanaConfigPaths(env);
  mkdirSync(paths.home, { recursive: true });

  const configRemoved = existsSync(paths.configPath);
  rmSync(paths.configPath, { force: true });
  const resetFiles = [
    { name: "config example", path: paths.configExamplePath, content: configExample() },
    { name: "MCP config", path: paths.mcpConfigPath, content: EMPTY_MCP_CONFIG },
    { name: "MCP activation state", path: paths.mcpEnabledPath, content: EMPTY_MCP_ACTIVATION },
    { name: "approvals", path: paths.approvalsPath, content: defaultApprovals() },
    { name: "skills config", path: paths.skillsConfigPath, content: EMPTY_SKILLS_CONFIG },
  ];
  for (const file of resetFiles) {
    writeFileAtomic(file.path, file.content);
  }

  return {
    configPath: paths.configPath,
    configRemoved,
    resetFiles: resetFiles.map(({ name, path }) => ({ name, path })),
  };
}

const EMPTY_MCP_CONFIG = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;
const EMPTY_MCP_ACTIVATION = `${JSON.stringify({ enabledServers: [] }, null, 2)}\n`;
const EMPTY_SKILLS_CONFIG = ["[model_invocation]", "enabled = []", ""].join("\n");

function configExample(): string {
  return serializeKanaConfigExample(DEFAULT_KANA_CONFIG);
}

function defaultApprovals(): string {
  return `${JSON.stringify(DEFAULT_KANA_TOOL_APPROVALS, null, 2)}\n`;
}

function installKanaFile(filePath: string, content: string): "created" | "exists" {
  if (existsSync(filePath)) {
    return "exists";
  }

  writeFileAtomic(filePath, content);
  return "created";
}

function writeGeneratedExample(
  filePath: string,
  content: string,
): "created" | "exists" | "updated" {
  if (!existsSync(filePath)) {
    writeFileAtomic(filePath, content);
    return "created";
  }
  if (readFileSync(filePath, "utf8") === content) {
    return "exists";
  }

  // The example is generated reference material rather than user configuration,
  // so refreshing it is safe and keeps upgrades aligned with the current schema.
  writeFileAtomic(filePath, content);
  return "updated";
}
