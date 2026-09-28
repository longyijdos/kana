export type KanaToolApprovals = {
  version: 3;
  shell: {
    exactCommands: string[];
    readOnlyCommands: string[];
  };
};

export const DEFAULT_KANA_TOOL_APPROVALS: KanaToolApprovals = {
  version: 3,
  shell: {
    exactCommands: [],
    readOnlyCommands: ["ls", "grep", "rg", "cat", "head", "tail", "wc", "pwd", "stat", "file"],
  },
};
