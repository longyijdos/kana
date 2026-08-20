import { existsSync, readFileSync } from "node:fs";

import type { ModelMetadata, ModelReasoningMetadata } from "@/core";

const CUSTOM_PROVIDER_KEYS = [
  "base_url",
  "api_key_env",
  "timeout_ms",
  "max_retries",
  "models",
] as const;

const CUSTOM_MODEL_KEYS = [
  "name",
  "context_window",
  "max_output_tokens",
  "supports_parallel_tool_calls",
  "supports_image_input",
  "reasoning_efforts",
  "default_reasoning_effort",
] as const;

export type KanaCustomProviderModel = {
  name: string;
  metadata: Omit<ModelMetadata, "provider" | "model" | "protocol">;
  defaultReasoningEffort?: string;
};

export type KanaCustomProvider = {
  baseUrl: string;
  apiKeyEnv?: string;
  timeoutMs: number;
  maxRetries: number;
  models: readonly KanaCustomProviderModel[];
};

export function loadKanaCustomProvider(filePath: string): KanaCustomProvider {
  if (!existsSync(filePath)) {
    throw new Error(
      `Custom provider configuration was not found at ${filePath}. Copy custom.example.toml to custom.toml and configure it.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Could not read custom provider configuration at ${filePath}.`, {
      cause: error,
    });
  }

  return parseKanaCustomProvider(parsed);
}

export function loadOptionalKanaCustomProvider(filePath: string): KanaCustomProvider | undefined {
  return existsSync(filePath) ? loadKanaCustomProvider(filePath) : undefined;
}

export function parseKanaCustomProvider(rawConfig: unknown): KanaCustomProvider {
  const config = asRecord(rawConfig, "custom provider");
  assertKnownKeys(config, CUSTOM_PROVIDER_KEYS, "custom provider");

  const baseUrl = readBaseUrl(config.base_url);
  const apiKeyEnv = readOptionalEnvironmentVariable(config.api_key_env);
  const timeoutMs = readPositiveInteger(config.timeout_ms, 60_000, "timeout_ms");
  const maxRetries = readNonNegativeInteger(config.max_retries, 1, "max_retries");
  const rawModels = config.models;
  if (!Array.isArray(rawModels) || rawModels.length === 0) {
    throw new Error("custom provider models must contain at least one [[models]] table.");
  }

  const models = rawModels.map((rawModel, index) => parseCustomModel(rawModel, index));
  const names = new Set<string>();
  for (const model of models) {
    if (names.has(model.name)) {
      throw new Error(`custom provider contains duplicate model name "${model.name}".`);
    }
    names.add(model.name);
  }

  return {
    baseUrl,
    apiKeyEnv,
    timeoutMs,
    maxRetries,
    models,
  };
}

export function getKanaCustomProviderModel(
  provider: KanaCustomProvider,
  name: string,
): KanaCustomProviderModel {
  const model = provider.models.find((candidate) => candidate.name === name);
  if (!model) {
    throw new Error(
      `Custom model "${name}" is not configured. Available models: ${provider.models
        .map((candidate) => candidate.name)
        .join(", ")}.`,
    );
  }
  return model;
}

export function resolveKanaCustomReasoning(
  model: KanaCustomProviderModel,
  selectedEffort?: string,
): string | undefined {
  const reasoning = model.metadata.reasoning;
  if (!reasoning) {
    if (selectedEffort !== undefined) {
      throw new Error(`Custom model "${model.name}" does not expose reasoning controls.`);
    }
    return undefined;
  }

  const effort = selectedEffort ?? model.defaultReasoningEffort;
  if (!effort || !reasoning.efforts.includes(effort)) {
    throw new Error(
      `Custom model "${model.name}" reasoning_effort must be one of: ${reasoning.efforts.join(", ")}.`,
    );
  }
  return effort;
}

export function serializeKanaCustomProviderExample(): string {
  return [
    "# OpenAI-compatible Custom provider example.",
    "# Copy this file to custom.toml and replace the example values.",
    'base_url = "https://api.example.com/v1"',
    'api_key_env = "CUSTOM_API_KEY"',
    "timeout_ms = 60000",
    "max_retries = 1",
    "",
    "[[models]]",
    'name = "my-model"',
    "context_window = 128000",
    "max_output_tokens = 8192",
    "supports_parallel_tool_calls = true",
    "supports_image_input = false",
    'reasoning_efforts = ["none", "low", "medium", "high"]',
    'default_reasoning_effort = "medium"',
    "",
  ].join("\n");
}

function parseCustomModel(rawModel: unknown, index: number): KanaCustomProviderModel {
  const path = `models[${index}]`;
  const model = asRecord(rawModel, path);
  assertKnownKeys(model, CUSTOM_MODEL_KEYS, path);

  const name = readRequiredString(model.name, `${path}.name`);
  const contextWindow = readRequiredPositiveInteger(model.context_window, `${path}.context_window`);
  const maxOutputTokens = readRequiredPositiveInteger(
    model.max_output_tokens,
    `${path}.max_output_tokens`,
  );
  if (maxOutputTokens > contextWindow) {
    throw new Error(`${path}.max_output_tokens cannot exceed context_window.`);
  }

  const reasoning = readReasoning(model, path);
  return {
    name,
    metadata: {
      contextWindow,
      maxOutputTokens,
      supportsParallelToolCalls: readBoolean(
        model.supports_parallel_tool_calls,
        false,
        `${path}.supports_parallel_tool_calls`,
      ),
      supportsHostedWebSearch: false,
      supportsImageInput: readBoolean(
        model.supports_image_input,
        false,
        `${path}.supports_image_input`,
      ),
      ...(reasoning ? { reasoning: reasoning.metadata } : {}),
    },
    ...(reasoning ? { defaultReasoningEffort: reasoning.defaultEffort } : {}),
  };
}

function readReasoning(
  model: Record<string, unknown>,
  path: string,
):
  | {
      metadata: ModelReasoningMetadata;
      defaultEffort: string;
    }
  | undefined {
  if (model.reasoning_efforts === undefined) {
    if (model.default_reasoning_effort !== undefined) {
      throw new Error(
        `${path}.reasoning_efforts is required when a reasoning default is configured.`,
      );
    }
    return undefined;
  }

  if (!Array.isArray(model.reasoning_efforts) || model.reasoning_efforts.length === 0) {
    throw new Error(`${path}.reasoning_efforts must be a non-empty array of strings.`);
  }
  const efforts = model.reasoning_efforts.map((effort, index) =>
    readRequiredString(effort, `${path}.reasoning_efforts[${index}]`),
  ) as [string, ...string[]];
  if (new Set(efforts).size !== efforts.length) {
    throw new Error(`${path}.reasoning_efforts must not contain duplicates.`);
  }
  if (efforts.includes("off")) {
    throw new Error(
      `${path}.reasoning_efforts uses "none" rather than "off" to disable reasoning.`,
    );
  }

  const defaultEffort = readRequiredString(
    model.default_reasoning_effort,
    `${path}.default_reasoning_effort`,
  );
  if (!efforts.includes(defaultEffort)) {
    throw new Error(`${path}.default_reasoning_effort must be listed in reasoning_efforts.`);
  }

  return {
    metadata: {
      efforts,
    },
    defaultEffort,
  };
}

function readBaseUrl(value: unknown): string {
  const baseUrl = readRequiredString(value, "base_url");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("base_url must be a valid absolute URL.");
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("base_url must not contain credentials, a query, or a fragment.");
  }
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isPrivateHost(parsed.hostname))
  ) {
    throw new Error(
      "base_url must use HTTPS, except for HTTP loopback or private-network endpoints.",
    );
  }

  return baseUrl.replace(/\/+$/, "");
}

function isPrivateHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") {
    return true;
  }

  const octets = hostname.split(".").map(Number);
  if (
    octets.length === 4 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
  ) {
    const [first, second] = octets;
    return (
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }

  const ipv6 = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return /^(?:fc|fd|fe[89ab])/.test(ipv6);
}

function readOptionalEnvironmentVariable(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const name = readRequiredString(value, "api_key_env");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error("api_key_env must be a valid environment variable name.");
  }
  return name;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be a TOML table.`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new Error(`${path}.${unknown} is not a supported Custom provider setting.`);
  }
}

function readRequiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${name} must be a non-empty string without surrounding whitespace.`);
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

function readRequiredPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function readPositiveInteger(value: unknown, fallback: number, name: string): number {
  return value === undefined ? fallback : readRequiredPositiveInteger(value, name);
}

function readNonNegativeInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}
