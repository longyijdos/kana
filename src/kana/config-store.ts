import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  getKanaConfigPaths,
  type KanaConfig,
  loadKanaConfig,
  parseKanaConfig,
  validateKanaConfig,
} from "./config";

type KanaConfigValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | undefined;

type KanaConfigField = {
  section: string;
  key: string;
  read(config: KanaConfig): KanaConfigValue;
};

export type KanaConfigStore = {
  load(): KanaConfig;
  update(mutate: (draft: KanaConfig) => void): KanaConfig;
};

// Keep the typed config and its canonical TOML leaves in one registry. Updates
// can then preserve unknown tables and comments instead of serializing defaults.
const CONFIG_FIELDS: KanaConfigField[] = [
  field("provider", "active", (config) => config.provider.active),
  field("model.deepseek", "name", (config) => config.model.deepseek.name),
  field("model.deepseek", "api_key_env", (config) => config.model.deepseek.apiKeyEnv),
  field("model.deepseek", "reasoning_effort", (config) => config.model.deepseek.reasoningEffort),
  field("model.deepseek", "web_search", (config) => config.model.deepseek.webSearch),
  field("model.deepseek", "image_input", (config) => config.model.deepseek.imageInput),
  field("model.deepseek", "max_tokens", (config) => config.model.deepseek.maxTokens),
  field("model.deepseek", "timeout_ms", (config) => config.model.deepseek.timeoutMs),
  field("model.deepseek", "max_retries", (config) => config.model.deepseek.maxRetries),
  field("model.openai-codex", "name", (config) => config.model["openai-codex"].name),
  field(
    "model.openai-codex",
    "reasoning_effort",
    (config) => config.model["openai-codex"].reasoningEffort,
  ),
  field(
    "model.openai-codex",
    "reasoning_summary",
    (config) => config.model["openai-codex"].reasoningSummary,
  ),
  field("model.openai-codex", "web_search", (config) => config.model["openai-codex"].webSearch),
  field("model.openai-codex", "image_input", (config) => config.model["openai-codex"].imageInput),
  field("model.openai-codex", "max_tokens", (config) => config.model["openai-codex"].maxTokens),
  field("model.openai-codex", "timeout_ms", (config) => config.model["openai-codex"].timeoutMs),
  field("model.openai-codex", "max_retries", (config) => config.model["openai-codex"].maxRetries),
  field("model.custom", "name", (config) => config.model.custom.name || undefined),
  field("model.custom", "reasoning_effort", (config) => config.model.custom.reasoningEffort),
  field("agent", "max_turns", (config) => config.agent.maxTurns),
  field("agent", "tool_deadline_ms", (config) => config.agent.toolDeadlineMs),
  field("agent", "parallel_tool_calls", (config) => config.agent.parallelToolCalls),
  field("agent", "max_parallel_tool_calls", (config) => config.agent.maxParallelToolCalls),
  field("agent", "context_limit", (config) => config.agent.contextLimit),
  field("agent", "tool_result_artifacts", (config) => config.agent.toolResultArtifacts),
  field(
    "agent.repeated_tool_calls",
    "reminder_thresholds",
    (config) => config.agent.repeatedToolCalls.reminderThresholds,
  ),
  field(
    "agent.repeated_tool_calls",
    "excluded_tools",
    (config) => config.agent.repeatedToolCalls.excludedTools,
  ),
  field("approval", "mode", (config) => config.approval.mode),
  field("notification", "backend", (config) => config.notification.backend),
  field("notification", "on_agent_completed", (config) => config.notification.onAgentCompleted),
  field("notification", "on_approval_required", (config) => config.notification.onApprovalRequired),
  field("tui", "hyperlinks", (config) => config.tui.hyperlinks),
  field("tui", "render_latex", (config) => config.tui.renderLatex),
  field("tui", "render_mermaid", (config) => config.tui.renderMermaid),
  field("tui", "smooth_text_streaming", (config) => config.tui.smoothTextStreaming),
  field("tui", "collapse_long_pastes", (config) => config.tui.collapseLongPastes),
  field("memory", "enabled", (config) => config.memory.enabled),
  field("memory", "max_chars", (config) => config.memory.maxChars),
  field("memory", "daily_retention_days", (config) => config.memory.dailyRetentionDays),
  field("logging", "level", (config) => config.logging.level),
];

export function createKanaConfigStore(env: NodeJS.ProcessEnv = process.env): KanaConfigStore {
  return {
    load: () => loadKanaConfig(env),
    update(mutate) {
      const current = loadKanaConfig(env);
      const next = structuredClone(current);
      mutate(next);
      const validated = validateKanaConfig(next);
      const changedFields = CONFIG_FIELDS.filter(
        (candidate) => !sameConfigValue(candidate.read(current), candidate.read(validated)),
      );
      if (changedFields.length === 0) {
        return current;
      }

      const { home, configPath } = getKanaConfigPaths(env);
      let document = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
      for (const changedField of changedFields) {
        document = updateTomlField(
          document,
          changedField.section,
          changedField.key,
          changedField.read(validated),
        );
      }

      const reloaded = parseKanaConfig(Bun.TOML.parse(document) as unknown);
      // Legacy layouts may shadow a newly added canonical key. Refuse the write
      // unless parsing the patched document produces the complete candidate.
      if (!sameKnownConfig(reloaded, validated)) {
        throw new Error(
          "Kana could not safely update this config.toml layout. Normalize the affected tables and try again.",
        );
      }

      mkdirSync(home, { recursive: true });
      writeConfigAtomically(configPath, document);
      return reloaded;
    },
  };
}

function field(section: string, key: string, read: KanaConfigField["read"]): KanaConfigField {
  return { section, key, read };
}

function sameKnownConfig(left: KanaConfig, right: KanaConfig): boolean {
  return CONFIG_FIELDS.every((candidate) =>
    sameConfigValue(candidate.read(left), candidate.read(right)),
  );
}

function sameConfigValue(left: KanaConfigValue, right: KanaConfigValue): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return left === right;
  }
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function updateTomlField(
  document: string,
  section: string,
  key: string,
  value: KanaConfigValue,
): string {
  const lines = document ? document.replace(/\r\n/g, "\n").split("\n") : [];
  while (lines.at(-1) === "") {
    lines.pop();
  }

  const sectionStart = findSection(lines, section);
  const sectionEnd =
    sectionStart === undefined ? undefined : findNextSection(lines, sectionStart + 1);
  const keyIndex =
    sectionStart === undefined
      ? undefined
      : findKey(lines, key, sectionStart + 1, sectionEnd ?? lines.length);

  if (value === undefined) {
    if (keyIndex !== undefined) {
      lines.splice(keyIndex, 1);
    }
    return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  }

  const assignment = `${key} = ${formatTomlValue(value)}`;
  if (keyIndex !== undefined) {
    lines[keyIndex] = assignment;
  } else if (sectionStart !== undefined) {
    let insertionIndex = sectionEnd ?? lines.length;
    while (insertionIndex > sectionStart + 1 && lines[insertionIndex - 1]?.trim() === "") {
      insertionIndex -= 1;
    }
    lines.splice(insertionIndex, 0, assignment);
  } else {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`[${section}]`, assignment);
  }

  return `${lines.join("\n")}\n`;
}

function findSection(lines: string[], section: string): number | undefined {
  const pattern = new RegExp(`^\\s*\\[${escapeRegExp(section)}\\]\\s*(?:#.*)?$`);
  for (const [index, line] of lines.entries()) {
    if (pattern.test(line)) {
      return index;
    }
  }
  return undefined;
}

function findNextSection(lines: string[], start: number): number | undefined {
  for (let index = start; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index] ?? "")) {
      return index;
    }
  }
  return undefined;
}

function findKey(lines: string[], key: string, start: number, end: number): number | undefined {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  for (let index = start; index < end; index += 1) {
    if (pattern.test(lines[index] ?? "")) {
      return index;
    }
  }
  return undefined;
}

function formatTomlValue(value: Exclude<KanaConfigValue, undefined>): string {
  if (typeof value === "string" || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return String(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeConfigAtomically(configPath: string, content: string): void {
  // A sibling temporary file keeps rename atomic on the target filesystem.
  const temporaryPath = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, configPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}
