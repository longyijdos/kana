export const COMMAND_MESSAGES = {
  helpUsage: "Usage: /help",
  forkUsage: "Usage: /fork <prompt>",
  deleteUsage: "Usage: /delete",
  skillsUsage: "Usage: /skills",
  helpTitle: "Slash commands",
  shellShortcutsTitle: "Shell shortcuts",
  shellShortcut: "!<command> Run a local bash command.",
  toolShortcut: "Ctrl+O Open the latest expandable tool output.",
  memoryUsage: [
    "Memory commands:",
    "  /memory show [user|workspace]",
    "    View saved memory. Omit the target to show both.",
    "  /memory compact [user|workspace] [request]",
    "    Compact saved memory. Omit the target to compact both.",
  ].join("\n"),
} as const;
