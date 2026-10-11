export type KanaToolApprovals = {
  readonly version: 3;
  readonly shell: {
    readonly exactCommands: readonly string[];
    readonly readOnlyCommands: readonly string[];
  };
};

export const DEFAULT_KANA_TOOL_APPROVALS: KanaToolApprovals = {
  version: 3,
  shell: {
    exactCommands: [],
    readOnlyCommands: ["ls", "grep", "rg", "cat", "head", "tail", "wc", "pwd", "stat", "file"],
  },
};
