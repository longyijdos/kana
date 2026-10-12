import { existsSync, readFileSync } from "node:fs";
import { type Static, Type } from "typebox";
import type { ModelMetadata, ModelReasoningMetadata } from "@/core";
import { parseWithSchema, positiveInteger, strictObject } from "@/utils";

export type KanaCustomProviderModel = {
  name: string;
  metadata: Omit<ModelMetadata, "provider" | "model" | "protocol">;
};

export type KanaCustomProvider = {
  baseUrl: string;
  apiKeyEnv?: string;
  timeoutMs: number;
  maxRetries: number;
  models: readonly KanaCustomProviderModel[];
};

export type KanaCustomProviderSnapshot =
  | { provider: KanaCustomProvider; error?: never }
  | { provider?: never; error: Error };

const trimmedString = () =>
  Type.String({
    pattern: "^\\S(?:.*\\S)?$",
    errorMessage: "must be a non-empty string without surrounding whitespace",
  });
const nonEmptyNames = () =>
  Type.Array(trimmedString(), {
    minItems: 1,
    uniqueItems: true,
    errorMessage: "must be a non-empty array of distinct strings",
  });

const CUSTOM_MODEL_SCHEMA = strictObject({
  name: trimmedString(),
  context_window: positiveInteger(),
  max_output_tokens: positiveInteger(),
  supports_parallel_tool_calls: Type.Optional(Type.Boolean()),
  supports_image_input: Type.Optional(Type.Boolean()),
  assistant_replay_fields: Type.Optional(nonEmptyNames()),
  reasoning_efforts: Type.Optional(nonEmptyNames()),
  default_reasoning_effort: Type.Optional(trimmedString()),
});

const CUSTOM_PROVIDER_SCHEMA = strictObject({
  base_url: trimmedString(),
  api_key_env: Type.Optional(
    Type.String({
      pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
      errorMessage: "must be a valid environment variable name",
    }),
  ),
  timeout_ms: Type.Optional(positiveInteger()),
  max_retries: Type.Optional(
    Type.Integer({ minimum: 0, errorMessage: "must be a non-negative integer" }),
  ),
  models: Type.Array(CUSTOM_MODEL_SCHEMA, {
    minItems: 1,
    errorMessage: "must contain at least one [[models]] table",
  }),
});

export function loadKanaCustomProviderSnapshot(filePath: string): KanaCustomProviderSnapshot {
  try {
    return { provider: loadKanaCustomProvider(filePath) };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error
          : new Error("Could not load Custom provider configuration.", { cause: error }),
    };
  }
}

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

export function parseKanaCustomProvider(rawConfig: unknown): KanaCustomProvider {
  const config = parseWithSchema(CUSTOM_PROVIDER_SCHEMA, rawConfig, "custom provider");
  const models = config.models.map((model, index) => parseCustomModel(model, `models[${index}]`));
  const names = new Set<string>();
  for (const model of models) {
    if (names.has(model.name)) {
      throw new Error(`custom provider contains duplicate model name "${model.name}".`);
    }
    names.add(model.name);
  }

  return {
    baseUrl: parseBaseUrl(config.base_url),
    apiKeyEnv: config.api_key_env,
    timeoutMs: config.timeout_ms ?? 60_000,
    maxRetries: config.max_retries ?? 1,
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
    '# assistant_replay_fields = ["reasoning_content"]',
    'reasoning_efforts = ["none", "low", "medium", "high"]',
    'default_reasoning_effort = "medium"',
    "",
  ].join("\n");
}

function parseCustomModel(
  model: Static<typeof CUSTOM_MODEL_SCHEMA>,
  path: string,
): KanaCustomProviderModel {
  if (model.max_output_tokens > model.context_window) {
    throw new Error(`${path}.max_output_tokens cannot exceed context_window.`);
  }
  const managedField = model.assistant_replay_fields?.find((field) =>
    ["role", "content", "tool_calls"].includes(field),
  );
  if (managedField !== undefined) {
    throw new Error(
      `${path}.assistant_replay_fields cannot include Kana-managed field "${managedField}".`,
    );
  }

  const reasoning = parseReasoning(model, path);
  return {
    name: model.name,
    metadata: {
      contextWindow: model.context_window,
      maxOutputTokens: model.max_output_tokens,
      supportsParallelToolCalls: model.supports_parallel_tool_calls ?? false,
      supportsHostedWebSearch: false,
      supportsImageInput: model.supports_image_input ?? false,
      ...(model.assistant_replay_fields
        ? { assistantReplayFields: model.assistant_replay_fields }
        : {}),
      ...(reasoning ? { reasoning } : {}),
    },
  };
}

function parseReasoning(
  model: Static<typeof CUSTOM_MODEL_SCHEMA>,
  path: string,
): ModelReasoningMetadata | undefined {
  const efforts = model.reasoning_efforts;
  const defaultEffort = model.default_reasoning_effort;
  if (efforts === undefined) {
    if (defaultEffort !== undefined) {
      throw new Error(
        `${path}.reasoning_efforts is required when a reasoning default is configured.`,
      );
    }
    return undefined;
  }
  if (efforts.includes("off")) {
    throw new Error(
      `${path}.reasoning_efforts uses "none" rather than "off" to disable reasoning.`,
    );
  }
  if (defaultEffort === undefined) {
    throw new Error(`${path}.default_reasoning_effort is required with reasoning_efforts.`);
  }
  if (!efforts.includes(defaultEffort)) {
    throw new Error(`${path}.default_reasoning_effort must be listed in reasoning_efforts.`);
  }
  return { efforts: efforts as [string, ...string[]], defaultEffort };
}

function parseBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("base_url must be a valid absolute URL.");
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("base_url must not contain credentials, a query, or a fragment.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("base_url must use HTTP or HTTPS.");
  }

  return baseUrl.replace(/\/+$/, "");
}
