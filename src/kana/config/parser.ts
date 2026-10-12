import { type TObject, type TSchema, Type } from "typebox";
import { LOG_LEVELS } from "@/logging";
import { isRecord, parseWithSchema } from "@/utils";
import { KANA_CONFIGURABLE_BUILT_IN_TOOL_NAMES } from "../tools/names";
import {
  KANA_MODEL_PROVIDERS,
  KANA_NOTIFICATION_BACKENDS,
  KANA_TOOL_APPROVAL_MODES,
  KANA_TUI_THEME_NAME_PATTERN,
  type KanaConfig,
  type KanaConfigDraft,
} from "./contracts";
import { DEFAULT_KANA_CONFIG } from "./defaults";

// config.toml uses snake_case keys for the camelCase fields of KanaConfig.
// Every field is optional; missing ones keep DEFAULT_KANA_CONFIG values.
const table = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Partial(Type.Object(properties), {
    additionalProperties: false,
    errorMessage: "must be a TOML table",
  });
const text = () => Type.String({ minLength: 1 });
const finiteNumber = () => Type.Number({ errorMessage: "must be a finite number" });
const positiveInteger = () =>
  Type.Integer({ minimum: 1, errorMessage: "must be a positive integer" });
const maxTurns = () =>
  Type.Union([Type.Literal(-1), Type.Integer({ minimum: 1 })], {
    errorMessage: "must be -1 or a positive integer",
  });

const modelTable = () =>
  table({
    provider: Type.Enum([...KANA_MODEL_PROVIDERS]),
    name: text(),
    reasoning_effort: text(),
    max_output_tokens: positiveInteger(),
    context_limit: positiveInteger(),
  });

const agentRuntimeFields = () => ({
  web_search: Type.Boolean(),
  image_input: Type.Boolean(),
  max_turns: maxTurns(),
  tool_deadline_ms: positiveInteger(),
  parallel_tool_calls: Type.Boolean(),
  max_parallel_tool_calls: positiveInteger(),
});

const REMINDER_THRESHOLDS_MESSAGE =
  "must contain strictly increasing integers greater than or equal to 2";

const KANA_CONFIG_FILE_SCHEMA = table({
  provider: table({
    deepseek: table({
      api_key_env: text(),
      timeout_ms: finiteNumber(),
      max_retries: finiteNumber(),
    }),
    "openai-codex": table({
      reasoning_summary: Type.Enum(["auto", "concise", "detailed"]),
      timeout_ms: finiteNumber(),
      max_retries: finiteNumber(),
    }),
  }),
  agent: table({
    tools: Type.Array(Type.Enum([...KANA_CONFIGURABLE_BUILT_IN_TOOL_NAMES]), {
      uniqueItems: true,
    }),
    codemode: Type.Enum(["off", "mixed", "only"]),
    ...agentRuntimeFields(),
    goal_max_rounds: positiveInteger(),
    tool_result_artifacts: Type.Boolean(),
    model: modelTable(),
    background_jobs: table({ max_concurrent: positiveInteger() }),
    subagents: table({ max_live: positiveInteger() }),
    repeated_tool_calls: table({
      reminder_thresholds: Type.Array(
        Type.Integer({ minimum: 2, errorMessage: REMINDER_THRESHOLDS_MESSAGE }),
        { errorMessage: REMINDER_THRESHOLDS_MESSAGE },
      ),
      excluded_tools: Type.Array(
        Type.String({ pattern: "^\\S(?:.*\\S)?$", errorMessage: "must be a trimmed tool name" }),
        { uniqueItems: true },
      ),
    }),
  }),
  approval: table({ mode: Type.Enum([...KANA_TOOL_APPROVAL_MODES]) }),
  notification: table({
    backend: Type.Enum([...KANA_NOTIFICATION_BACKENDS]),
    on_agent_completed: Type.Boolean(),
    on_approval_required: Type.Boolean(),
  }),
  tui: table({
    theme: Type.String({
      pattern: KANA_TUI_THEME_NAME_PATTERN,
      errorMessage:
        "must be a lowercase theme identifier using letters, numbers, underscores, or hyphens (maximum 64 characters)",
    }),
    hyperlinks: Type.Boolean(),
    render_latex: Type.Boolean(),
    render_mermaid: Type.Boolean(),
    smooth_text_streaming: Type.Boolean(),
    collapse_long_pastes: Type.Boolean(),
  }),
  memory: table({
    enabled: Type.Boolean(),
    max_chars: positiveInteger(),
    daily_retention_days: positiveInteger(),
    agent: table({ ...agentRuntimeFields(), model: modelTable() }),
  }),
  logging: table({ level: Type.Enum([...LOG_LEVELS]) }),
});

export function parseKanaConfig(raw: unknown): KanaConfig {
  const file = parseWithSchema(KANA_CONFIG_FILE_SCHEMA, raw, "config");
  const thresholds = file.agent?.repeated_tool_calls?.reminder_thresholds ?? [];
  if (thresholds.some((value, index) => index > 0 && value <= (thresholds[index - 1] ?? 0))) {
    throw new Error(
      `agent.repeated_tool_calls.reminder_thresholds ${REMINDER_THRESHOLDS_MESSAGE}.`,
    );
  }
  return mergeTable(DEFAULT_KANA_CONFIG, file) as KanaConfig;
}

function validateKanaConfig(config: KanaConfig): KanaConfig {
  return parseKanaConfig(toKanaConfigFile(config));
}

// Applies `mutate` to a private copy of `config` and validates the result.
export function reviseKanaConfig(
  config: KanaConfig,
  mutate: (draft: KanaConfigDraft) => void,
): KanaConfig {
  const draft = structuredClone(config) as KanaConfigDraft;
  mutate(draft);
  return validateKanaConfig(draft);
}

export function toKanaConfigFile(config: KanaConfig): Record<string, unknown> {
  return mapTable(config, camelToSnake);
}

// Lists every leaf of config.toml as its table path, key and KanaConfig field
// path, in schema order.
export function listKanaConfigLeaves(
  schema: TObject = KANA_CONFIG_FILE_SCHEMA,
  tablePath: readonly string[] = [],
): { section: string; key: string; fieldPath: string[] }[] {
  return Object.entries(schema.properties).flatMap(([key, child]) => {
    const keys = [...tablePath, key];
    return "properties" in child
      ? listKanaConfigLeaves(child as TObject, keys)
      : [{ section: tablePath.join("."), key, fieldPath: keys.map(snakeToCamel) }];
  });
}

function mergeTable(
  defaults: Readonly<Record<string, unknown>>,
  raw: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(raw)) {
    const field = snakeToCamel(key);
    const fallback = defaults[field];
    merged[field] = isRecord(value) ? mergeTable(isRecord(fallback) ? fallback : {}, value) : value;
  }
  return merged;
}

function mapTable(
  value: Readonly<Record<string, unknown>>,
  mapKey: (key: string) => string,
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) {
      mapped[mapKey(key)] = isRecord(child) ? mapTable(child, mapKey) : child;
    }
  }
  return mapped;
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
