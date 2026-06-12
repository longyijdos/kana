import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { DeepSeekReasoningEffort } from "@/providers/deepseek";

export type KanaModelConfig = {
  provider: "deepseek";
  name: string;
  apiKeyEnv: string;
  thinking: boolean;
  reasoningEffort: DeepSeekReasoningEffort;
  maxTokens: number;
  timeoutMs: number;
  maxRetries: number;
};

export type KanaAgentConfig = {
  maxTurns: number;
};

export type KanaConfig = {
  model: KanaModelConfig;
  agent: KanaAgentConfig;
};

export type KanaConfigPaths = {
  home: string;
  configPath: string;
  agentsPath: string;
  sessionsPath: string;
};

export type InstallKanaConfigOptions = {
  force?: boolean;
};

export type InstallKanaConfigResult = {
  configPath: string;
  status: "created" | "exists" | "reinstalled";
};

export const DEFAULT_KANA_CONFIG: KanaConfig = {
  model: {
    provider: "deepseek",
    name: "deepseek-v4-pro",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    thinking: true,
    reasoningEffort: "high",
    maxTokens: 8192,
    timeoutMs: 60_000,
    maxRetries: 1,
  },
  agent: {
    maxTurns: -1,
  },
};

export function getKanaConfigPaths(
  env: NodeJS.ProcessEnv = process.env,
): KanaConfigPaths {
  const home = env.KANA_HOME ?? path.join(env.HOME ?? homedir(), ".kana");

  return {
    home,
    configPath: path.join(home, "config.toml"),
    agentsPath: path.join(home, "AGENTS.md"),
    sessionsPath: path.join(home, "sessions"),
  };
}

export function loadKanaConfig(
  env: NodeJS.ProcessEnv = process.env,
): KanaConfig {
  const { configPath } = getKanaConfigPaths(env);

  if (!existsSync(configPath)) {
    return DEFAULT_KANA_CONFIG;
  }

  const parsed = Bun.TOML.parse(readFileSync(configPath, "utf8")) as unknown;
  return mergeKanaConfig(DEFAULT_KANA_CONFIG, parsed);
}

export function installKanaConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: InstallKanaConfigOptions = {},
): InstallKanaConfigResult {
  const { home, configPath } = getKanaConfigPaths(env);
  mkdirSync(home, { recursive: true });

  const exists = existsSync(configPath);
  if (exists && !options.force) {
    return { configPath, status: "exists" };
  }

  writeFileSync(configPath, serializeKanaConfig(DEFAULT_KANA_CONFIG), {
    encoding: "utf8",
    mode: 0o600,
  });

  return {
    configPath,
    status: exists ? "reinstalled" : "created",
  };
}

function serializeKanaConfig(config: KanaConfig): string {
  return [
    "[model]",
    `provider = "${config.model.provider}"`,
    `name = "${config.model.name}"`,
    `api_key_env = "${config.model.apiKeyEnv}"`,
    `thinking = ${config.model.thinking}`,
    `reasoning_effort = "${config.model.reasoningEffort}"`,
    `max_tokens = ${config.model.maxTokens}`,
    `timeout_ms = ${config.model.timeoutMs}`,
    `max_retries = ${config.model.maxRetries}`,
    "",
    "[agent]",
    `max_turns = ${config.agent.maxTurns}`,
    "",
  ].join("\n");
}

function mergeKanaConfig(defaults: KanaConfig, rawConfig: unknown): KanaConfig {
  const raw = asRecord(rawConfig, "config");
  const model = raw.model === undefined ? {} : asRecord(raw.model, "model");
  const agent = raw.agent === undefined ? {} : asRecord(raw.agent, "agent");

  return {
    model: {
      provider: readDeepSeekProvider(model.provider, defaults.model.provider),
      name: readString(model.name, defaults.model.name, "model.name"),
      apiKeyEnv: readString(
        model.api_key_env,
        defaults.model.apiKeyEnv,
        "model.api_key_env",
      ),
      thinking: readBoolean(
        model.thinking,
        defaults.model.thinking,
        "model.thinking",
      ),
      reasoningEffort: readReasoningEffort(
        model.reasoning_effort,
        defaults.model.reasoningEffort,
      ),
      maxTokens: readNumber(
        model.max_tokens,
        defaults.model.maxTokens,
        "model.max_tokens",
      ),
      timeoutMs: readNumber(
        model.timeout_ms,
        defaults.model.timeoutMs,
        "model.timeout_ms",
      ),
      maxRetries: readNumber(
        model.max_retries,
        defaults.model.maxRetries,
        "model.max_retries",
      ),
    },
    agent: {
      maxTurns: readNumber(
        agent.max_turns,
        defaults.agent.maxTurns,
        "agent.max_turns",
      ),
    },
  };
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be a TOML table.`);
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown, fallback: string, name: string): string {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }

  return value;
}

function readBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean.`);
  }

  return value;
}

function readNumber(value: unknown, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }

  return value;
}

function readDeepSeekProvider(
  value: unknown,
  fallback: "deepseek",
): "deepseek" {
  const provider = readString(value, fallback, "model.provider");

  if (provider !== "deepseek") {
    throw new Error(`Unsupported model.provider: ${provider}`);
  }

  return provider;
}

function readReasoningEffort(
  value: unknown,
  fallback: DeepSeekReasoningEffort,
): DeepSeekReasoningEffort {
  const effort = readString(value, fallback, "model.reasoning_effort");

  if (effort !== "high" && effort !== "max") {
    throw new Error(`model.reasoning_effort must be "high" or "max".`);
  }

  return effort;
}
