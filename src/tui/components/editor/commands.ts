export type PromptCommandName =
  | "quit"
  | "help"
  | "clear"
  | "new"
  | "fork"
  | "resume"
  | "delete"
  | "skills"
  | "mcp"
  | "memory"
  | "usage";

export type PromptCommand = {
  name: PromptCommandName;
  argumentSyntax?: string;
  description: string;
};

export type PromptShortcut = {
  input: string;
  description: string;
};

export type PromptSubmit =
  | {
      type: "message";
      content: string;
    }
  | {
      type: "shell";
      command: string;
      raw: string;
    }
  | {
      type: "command";
      name: PromptCommandName;
      arguments: string;
      raw: string;
    };

export type CommandState = {
  isCommandMode: boolean;
  showPalette: boolean;
  query: string;
  suggestions: PromptCommand[];
};

export const PROMPT_COMMANDS: PromptCommand[] = [
  {
    name: "quit",
    description: "Exit Kana.",
  },
  {
    name: "help",
    description: "Show slash commands.",
  },
  {
    name: "clear",
    description: "Clear the transcript.",
  },
  {
    name: "new",
    description: "Start a new session.",
  },
  {
    name: "fork",
    argumentSyntax: "<prompt>",
    description: "Fork the current session and send a prompt.",
  },
  {
    name: "resume",
    argumentSyntax: "[id]",
    description: "Switch to a saved session.",
  },
  {
    name: "delete",
    description: "Delete a saved session.",
  },
  {
    name: "skills",
    description: "Manage active skills.",
  },
  {
    name: "mcp",
    description: "Manage active MCP servers.",
  },
  {
    name: "memory",
    description: "View or compact saved memory.",
  },
  {
    name: "usage",
    description: "Show session, project, or global API usage.",
  },
];

export const PROMPT_HELP_TITLE = "Slash commands";
export const PROMPT_SHORTCUTS_TITLE = "Shell shortcuts";
export const PROMPT_SHORTCUTS: PromptShortcut[] = [
  {
    input: "!<command>",
    description: "Run a local bash command.",
  },
  {
    input: "Ctrl+O",
    description: "Open the latest expandable tool output.",
  },
];

const PROMPT_COMMAND_SYNTAX_WIDTH = Math.max(
  ...PROMPT_COMMANDS.map((command) => formatPromptCommandSyntax(command).length),
);
const PROMPT_SHORTCUT_INPUT_WIDTH = Math.max(
  ...PROMPT_SHORTCUTS.map((shortcut) => shortcut.input.length),
);

export function formatPromptCommandSyntax(command: PromptCommand): string {
  return `/${command.name}${command.argumentSyntax ? ` ${command.argumentSyntax}` : ""}`;
}

export function formatPromptCommandHelpLine(command: PromptCommand): string {
  return `${formatPromptCommandSyntax(command).padEnd(PROMPT_COMMAND_SYNTAX_WIDTH)} ${command.description}`;
}

export function formatPromptCommandUsage(name: PromptCommandName): string {
  const command = PROMPT_COMMANDS.find((candidate) => candidate.name === name);

  if (!command) {
    throw new Error(`Unknown prompt command: ${name}`);
  }

  return `Usage: ${formatPromptCommandSyntax(command)}`;
}

export function formatPromptShortcutHelpLine(shortcut: PromptShortcut): string {
  return `${shortcut.input.padEnd(PROMPT_SHORTCUT_INPUT_WIDTH)} ${shortcut.description}`;
}

export function getCommandState(value: string): CommandState {
  if (!value.startsWith("/")) {
    return {
      isCommandMode: false,
      showPalette: false,
      query: "",
      suggestions: [],
    };
  }

  const commandTokenEnd = findCommandTokenEnd(value);
  const query = value.slice(1, commandTokenEnd);

  return {
    isCommandMode: true,
    showPalette: commandTokenEnd === value.length,
    query,
    suggestions: PROMPT_COMMANDS.filter((command) => command.name.startsWith(query)),
  };
}

export function completeCommand(command: PromptCommand): string {
  return `/${command.name} `;
}

export function createRandomPromptPlaceholder(random = Math.random, previous?: string): string {
  const placeholders = [
    ...PROMPT_COMMANDS.map(
      (command) => `Try ${formatPromptCommandSyntax(command)} — ${command.description}`,
    ),
    ...PROMPT_SHORTCUTS.map((shortcut) => `Try ${shortcut.input} — ${shortcut.description}`),
  ];
  const candidates =
    placeholders.length > 1
      ? placeholders.filter((placeholder) => placeholder !== previous)
      : placeholders;

  return candidates[Math.floor(random() * candidates.length)] ?? placeholders[0] ?? "";
}

export function createCommandSubmit(
  value: string,
  selectedCommand: PromptCommand | undefined,
): PromptSubmit | undefined {
  if (value.startsWith("!")) {
    const command = value.slice(1).trim();

    return command
      ? {
          type: "shell",
          command,
          raw: value,
        }
      : {
          type: "message",
          content: value,
        };
  }

  const state = getCommandState(value);

  if (!state.isCommandMode) {
    return {
      type: "message",
      content: value,
    };
  }

  const command =
    PROMPT_COMMANDS.find((candidate) => candidate.name === state.query) ??
    (state.suggestions.length > 0 ? selectedCommand : undefined);

  if (!command) {
    return {
      type: "message",
      content: value,
    };
  }

  return {
    type: "command",
    name: command.name,
    arguments: getCommandArguments(value),
    raw: value,
  };
}

function findCommandTokenEnd(value: string): number {
  const match = /^\/\S*/.exec(value);

  return match ? match[0].length : value.length;
}

function getCommandArguments(value: string): string {
  return value.slice(findCommandTokenEnd(value)).trim();
}
