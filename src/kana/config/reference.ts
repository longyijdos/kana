import type { KanaConfig, KanaModelConfig } from "./contracts";

export function serializeKanaConfigExample(config: KanaConfig): string {
  return [
    "# Generated configuration reference. Kana does not read this file.",
    "# Copy only the settings you want to override into config.toml.",
    "",
    "[provider.deepseek]",
    `api_key_env = "${config.provider.deepseek.apiKeyEnv}"`,
    `timeout_ms = ${config.provider.deepseek.timeoutMs}`,
    `max_retries = ${config.provider.deepseek.maxRetries}`,
    "",
    "[provider.openai-codex]",
    `reasoning_summary = "${config.provider["openai-codex"].reasoningSummary}"`,
    `timeout_ms = ${config.provider["openai-codex"].timeoutMs}`,
    `max_retries = ${config.provider["openai-codex"].maxRetries}`,
    "",
    "[agent]",
    `tools = ${JSON.stringify(config.agent.tools)}`,
    `web_search = ${config.agent.webSearch}`,
    `image_input = ${config.agent.imageInput}`,
    `max_turns = ${config.agent.maxTurns}`,
    `goal_max_rounds = ${config.agent.goalMaxRounds}`,
    `tool_deadline_ms = ${config.agent.toolDeadlineMs}`,
    `parallel_tool_calls = ${config.agent.parallelToolCalls}`,
    `max_parallel_tool_calls = ${config.agent.maxParallelToolCalls}`,
    `tool_result_artifacts = ${config.agent.toolResultArtifacts}`,
    "",
    "[agent.model]",
    ...serializeModelConfig(config.agent.model, {
      reasoningEffort: "high",
      maxOutputTokens: 128_000,
      contextLimit: 500_000,
    }),
    "",
    "[agent.background_jobs]",
    `max_concurrent = ${config.agent.backgroundJobs.maxConcurrent}`,
    "",
    "[agent.subagents]",
    `max_live = ${config.agent.subagents.maxLive}`,
    "",
    "[agent.repeated_tool_calls]",
    `reminder_thresholds = ${JSON.stringify(config.agent.repeatedToolCalls.reminderThresholds)}`,
    `excluded_tools = ${JSON.stringify(config.agent.repeatedToolCalls.excludedTools)}`,
    "",
    "[approval]",
    `mode = "${config.approval.mode}"`,
    "",
    "[notification]",
    `backend = "${config.notification.backend}"`,
    `on_agent_completed = ${config.notification.onAgentCompleted}`,
    `on_approval_required = ${config.notification.onApprovalRequired}`,
    "",
    "[tui]",
    `theme = "${config.tui.theme}"`,
    `hyperlinks = ${config.tui.hyperlinks}`,
    `render_latex = ${config.tui.renderLatex}`,
    `render_mermaid = ${config.tui.renderMermaid}`,
    `smooth_text_streaming = ${config.tui.smoothTextStreaming}`,
    `collapse_long_pastes = ${config.tui.collapseLongPastes}`,
    "",
    "[memory]",
    `enabled = ${config.memory.enabled}`,
    `max_chars = ${config.memory.maxChars}`,
    "# daily_retention_days = 30",
    "",
    "[memory.agent]",
    `web_search = ${config.memory.agent.webSearch}`,
    `image_input = ${config.memory.agent.imageInput}`,
    `max_turns = ${config.memory.agent.maxTurns}`,
    `tool_deadline_ms = ${config.memory.agent.toolDeadlineMs}`,
    `parallel_tool_calls = ${config.memory.agent.parallelToolCalls}`,
    `max_parallel_tool_calls = ${config.memory.agent.maxParallelToolCalls}`,
    "",
    "[memory.agent.model]",
    "# Inherits [agent.model]. Uncomment a field to override it.",
    ...serializeModelConfig(config.memory.agent.model, {
      provider: config.agent.model.provider,
      name: config.agent.model.name,
      reasoningEffort: config.agent.model.reasoningEffort,
      maxOutputTokens: config.agent.model.maxOutputTokens,
      contextLimit: config.agent.model.contextLimit,
    }),
    "",
    "[logging]",
    `level = "${config.logging.level}"`,
    "",
  ].join("\n");
}

export function serializeKanaSubagentProfileExample(): string {
  return [
    "---",
    "description: Review database migrations",
    "tools:",
    "  - list",
    "  - grep",
    "  - read",
    "  - bash",
    "# model: openai-codex/gpt-5.6-terra",
    "# reasoning_effort: high",
    "---",
    "",
    "Review the delegated task.",
    "Report correctness risks with concrete file references.",
    "Do not modify files.",
    "",
  ].join("\n");
}

export function serializeKanaPromptTemplateExample(): string {
  return [
    "---",
    "# Copy this file to prompts/squash-cleanup.md, then invoke :squash-cleanup.",
    "# Override defaults with arguments such as base=develop.",
    "description: Clean up a squash-merged branch and worktree",
    "---",
    "",
    "The PR was squash merged. Switch back to {{base=main}}, fast-forward it,",
    "then clean up {{branch=the merged branch}} and its related worktree if safe.",
    "",
  ].join("\n");
}

function serializeModelConfig(
  config: Readonly<Partial<KanaModelConfig>>,
  hints: Readonly<Partial<KanaModelConfig>>,
): string[] {
  return [
    modelLine("provider", config.provider, hints.provider),
    modelLine("name", config.name, hints.name),
    modelLine("reasoning_effort", config.reasoningEffort, hints.reasoningEffort),
    modelLine("max_output_tokens", config.maxOutputTokens, hints.maxOutputTokens),
    modelLine("context_limit", config.contextLimit, hints.contextLimit),
  ].filter((line): line is string => line !== undefined);
}

function modelLine(
  key: string,
  value: string | number | undefined,
  hint: string | number | undefined,
): string | undefined {
  if (value !== undefined) {
    return `${key} = ${formatModelValue(value)}`;
  }
  return hint === undefined ? undefined : `# ${key} = ${formatModelValue(hint)}`;
}

function formatModelValue(value: string | number): string {
  return typeof value === "string" ? `"${value}"` : `${value}`;
}
