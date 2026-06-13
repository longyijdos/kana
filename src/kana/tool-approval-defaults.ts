export type KanaToolApprovals = {
  version: 2;
  bash: {
    exactCommands: string[];
    readOnlyCommands: string[];
  };
};

export const DEFAULT_KANA_TOOL_APPROVALS: KanaToolApprovals = {
  version: 2,
  bash: {
    exactCommands: [],
    readOnlyCommands: [
      "ls",
      "grep",
      "rg",
      "cat",
      "head",
      "tail",
      "wc",
      "pwd",
      "stat",
      "file",
    ],
  },
};
