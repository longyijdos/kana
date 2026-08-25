import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { DEEPSEEK_MODELS, OPENAI_CODEX_MODELS } from "@/providers";
import {
  KANA_MODEL_PROVIDERS,
  type KanaDeepSeekModelConfig,
  type KanaMainAgentModelSelection,
  type KanaModelProvider,
  type KanaNotificationBackend,
  type KanaNotificationConfig,
  type KanaOpenAICodexModelConfig,
  type KanaRepeatedToolCallsConfig,
  type KanaToolApprovalConfig,
  type KanaToolApprovalMode,
  type KanaTuiConfig,
  type ResolvedKanaConfig,
  type ResolvedKanaMainAgentConfig,
  type ResolvedKanaMemoryConfig,
  type ResolvedKanaModelConfig,
  resolveKanaConfig,
} from "./config-resolver";
import { loadKanaCustomProvider, serializeKanaCustomProviderExample } from "./custom-provider";
import { DEFAULT_KANA_TOOL_APPROVALS } from "./tool-approval-defaults";

export { KANA_MODEL_PROVIDERS };
export type {
  KanaMainAgentModelSelection,
  KanaModelProvider,
  KanaNotificationBackend,
  KanaNotificationConfig,
  KanaRepeatedToolCallsConfig,
  KanaToolApprovalConfig,
  KanaToolApprovalMode,
  KanaTuiConfig,
  ResolvedKanaConfig,
  ResolvedKanaMainAgentConfig,
  ResolvedKanaMemoryConfig,
  ResolvedKanaModelConfig,
};

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

export function parseKanaConfig(
  rawConfig: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedKanaConfig {
  const { customProviderPath } = getKanaConfigPaths(env);
  return resolveKanaConfig(rawConfig, {
    customProviderPath,
    loadCustomProvider: () => loadKanaCustomProvider(customProviderPath),
  });
}

export const DEFAULT_KANA_CONFIG: ResolvedKanaConfig = parseKanaConfig({});

export function loadKanaConfig(env: NodeJS.ProcessEnv = process.env): ResolvedKanaConfig {
  const { configPath } = getKanaConfigPaths(env);
  if (!existsSync(configPath)) {
    return structuredClone(DEFAULT_KANA_CONFIG);
  }

  return parseKanaConfig(Bun.TOML.parse(readFileSync(configPath, "utf8")) as unknown, env);
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

  return {
    configPath,
    configStatus: existsSync(configPath) ? "exists" : "defaults",
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

function serializeKanaConfigExample(config: ResolvedKanaConfig): string {
  const lines = [
    "# Generated configuration reference. Kana does not read this file.",
    "# Copy only the settings you want to override into config.toml.",
    "",
    "[provider.deepseek]",
    `api_key_env = ${JSON.stringify(config.provider.deepseek.apiKeyEnv)}`,
    `timeout_ms = ${config.provider.deepseek.timeoutMs}`,
    `max_retries = ${config.provider.deepseek.maxRetries}`,
    "",
    "[provider.openai-codex]",
    `timeout_ms = ${config.provider["openai-codex"].timeoutMs}`,
    `max_retries = ${config.provider["openai-codex"].maxRetries}`,
    "",
  ];

  for (const name of Object.keys(DEEPSEEK_MODELS)) {
    const model = config.model.deepseek[name];
    if (!model) continue;
    lines.push(`[model.deepseek.${JSON.stringify(name)}]`, ...serializeDeepSeekModel(model), "");
  }
  for (const name of Object.keys(OPENAI_CODEX_MODELS)) {
    const model = config.model["openai-codex"][name];
    if (!model) continue;
    lines.push(
      `[model.openai-codex.${JSON.stringify(name)}]`,
      ...serializeOpenAICodexModel(model),
      "",
    );
  }

  lines.push(
    "# Custom provider transport, model metadata, and defaults live in providers/custom.toml.",
    "",
    "[agent]",
    `provider = ${JSON.stringify(config.agent.model.provider)}`,
    `model = ${JSON.stringify(config.agent.model.model)}`,
    `max_turns = ${config.agent.maxTurns}`,
    `tool_deadline_ms = ${config.agent.toolDeadlineMs}`,
    `parallel_tool_calls = ${config.agent.parallelToolCalls}`,
    `max_parallel_tool_calls = ${config.agent.maxParallelToolCalls}`,
    `tool_result_artifacts = ${config.agent.toolResultArtifacts}`,
    '# reasoning_effort = "max"',
    "# web_search = false",
    "",
    "[agent.repeated_tool_calls]",
    `reminder_thresholds = ${JSON.stringify(config.agent.repeatedToolCalls.reminderThresholds)}`,
    `excluded_tools = ${JSON.stringify(config.agent.repeatedToolCalls.excludedTools)}`,
    "",
    "[memory]",
    `enabled = ${config.memory.enabled}`,
    `max_chars = ${config.memory.maxChars}`,
    "# daily_retention_days = 30",
    "",
    "[memory.agent]",
    `provider = ${JSON.stringify(config.memory.agent.model.provider)}`,
    `model = ${JSON.stringify(config.memory.agent.model.model)}`,
    `max_turns = ${config.memory.agent.maxTurns}`,
    `tool_deadline_ms = ${config.memory.agent.toolDeadlineMs}`,
    `parallel_tool_calls = ${config.memory.agent.parallelToolCalls}`,
    `max_parallel_tool_calls = ${config.memory.agent.maxParallelToolCalls}`,
    "",
    "[goal]",
    `max_rounds = ${config.goal.maxRounds}`,
    "",
    "[background_jobs]",
    `max_concurrent = ${config.backgroundJobs.maxConcurrent}`,
    "",
    "[approval]",
    `mode = ${JSON.stringify(config.approval.mode)}`,
    "",
    "[notification]",
    `backend = ${JSON.stringify(config.notification.backend)}`,
    `on_agent_completed = ${config.notification.onAgentCompleted}`,
    `on_approval_required = ${config.notification.onApprovalRequired}`,
    "",
    "[tui]",
    `hyperlinks = ${config.tui.hyperlinks}`,
    `render_latex = ${config.tui.renderLatex}`,
    `render_mermaid = ${config.tui.renderMermaid}`,
    `smooth_text_streaming = ${config.tui.smoothTextStreaming}`,
    `collapse_long_pastes = ${config.tui.collapseLongPastes}`,
    "",
    "[logging]",
    `level = ${JSON.stringify(config.logging.level)}`,
    "",
  );

  return lines.join("\n");
}

function serializeDeepSeekModel(config: KanaDeepSeekModelConfig): string[] {
  return [
    `reasoning_effort = ${JSON.stringify(config.reasoningEffort)}`,
    `web_search = ${config.webSearch}`,
    `image_input = ${config.imageInput}`,
    `max_output_tokens = ${config.maxOutputTokens}`,
    `# context_limit = ${config.contextLimit}`,
  ];
}

function serializeOpenAICodexModel(config: KanaOpenAICodexModelConfig): string[] {
  return [
    `reasoning_effort = ${JSON.stringify(config.reasoningEffort)}`,
    `reasoning_summary = ${JSON.stringify(config.reasoningSummary)}`,
    `web_search = ${config.webSearch}`,
    `image_input = ${config.imageInput}`,
    `max_output_tokens = ${config.maxOutputTokens}`,
    `# context_limit = ${config.contextLimit}`,
  ];
}

function installKanaFile(filePath: string, content: string): "created" | "exists" {
  if (existsSync(filePath)) return "exists";
  writeKanaFile(filePath, content);
  return "created";
}

function writeGeneratedConfigExample(
  configExamplePath: string,
): InstallKanaConfigResult["configExampleStatus"] {
  return writeGeneratedExample(configExamplePath, serializeKanaConfigExample(DEFAULT_KANA_CONFIG));
}

function writeGeneratedExample(
  filePath: string,
  content: string,
): "created" | "exists" | "updated" {
  if (!existsSync(filePath)) {
    writeKanaFile(filePath, content);
    return "created";
  }
  if (readFileSync(filePath, "utf8") === content) return "exists";
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
