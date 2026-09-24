export const KANA_WORKSPACE_TOOL_NAMES = [
  "list",
  "glob",
  "grep",
  "read",
  "view_image",
  "write",
  "edit",
  "bash",
] as const;

const KANA_BACKGROUND_JOB_TOOL_NAMES = ["job_start", "job_list", "job_output", "job_kill"] as const;

const KANA_SUBAGENT_TOOL_NAMES = ["spawn_subagent", "wait_subagent", "cancel_subagent"] as const;

const KANA_MCP_TOOL_NAMES = ["mcp_list_tools", "mcp_call"] as const;

export const KANA_CONFIGURABLE_BUILT_IN_TOOL_NAMES = [
  ...KANA_WORKSPACE_TOOL_NAMES,
  ...KANA_BACKGROUND_JOB_TOOL_NAMES,
  ...KANA_SUBAGENT_TOOL_NAMES,
  "todo_write",
  "delegate_user_task",
  "remember",
  "schedule_wake",
  ...KANA_MCP_TOOL_NAMES,
] as const;

export type KanaConfigurableBuiltInToolName =
  (typeof KANA_CONFIGURABLE_BUILT_IN_TOOL_NAMES)[number];

export const KANA_BUILT_IN_TOOL_NAMES = [
  ...KANA_WORKSPACE_TOOL_NAMES,
  ...KANA_BACKGROUND_JOB_TOOL_NAMES,
  ...KANA_SUBAGENT_TOOL_NAMES,
  "todo_write",
  "delegate_user_task",
  "update_goal",
  "remember",
  "schedule_wake",
  ...KANA_MCP_TOOL_NAMES,
] as const;
