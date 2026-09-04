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
    ...serializeModelConfig(config.memory.agent.model, {
      reasoningEffort: "low",
      maxOutputTokens: 64_000,
      contextLimit: 200_000,
    }),
    "",
    "[logging]",
    `level = "${config.logging.level}"`,
    "",
  ].join("\n");
}

function serializeModelConfig(
  config: KanaModelConfig,
  examples: {
    reasoningEffort: string;
    maxOutputTokens: number;
    contextLimit: number;
  },
): string[] {
  return [
    `provider = "${config.provider}"`,
    `name = "${config.name}"`,
    config.reasoningEffort === undefined
      ? `# reasoning_effort = "${examples.reasoningEffort}"`
      : `reasoning_effort = "${config.reasoningEffort}"`,
    config.maxOutputTokens === undefined
      ? `# max_output_tokens = ${examples.maxOutputTokens}`
      : `max_output_tokens = ${config.maxOutputTokens}`,
    config.contextLimit === undefined
      ? `# context_limit = ${examples.contextLimit}`
      : `context_limit = ${config.contextLimit}`,
  ];
}
