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

export const KANA_CONFIGURABLE_BUILT_IN_TOOL_NAMES = [
  ...KANA_WORKSPACE_TOOL_NAMES,
  ...KANA_BACKGROUND_JOB_TOOL_NAMES,
  ...KANA_SUBAGENT_TOOL_NAMES,
  "todo_write",
  "remember",
  "schedule_wake",
] as const;

export type KanaConfigurableBuiltInToolName =
  (typeof KANA_CONFIGURABLE_BUILT_IN_TOOL_NAMES)[number];

export const KANA_BUILT_IN_TOOL_NAMES = [
  ...KANA_WORKSPACE_TOOL_NAMES,
  ...KANA_BACKGROUND_JOB_TOOL_NAMES,
  ...KANA_SUBAGENT_TOOL_NAMES,
  "todo_write",
  "update_goal",
  "remember",
  "schedule_wake",
] as const;
