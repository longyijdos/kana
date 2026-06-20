export type PromptCommandName =
  | "quit"
  | "help"
  | "clear"
  | "new"
  | "fork"
  | "resume"
  | "delete"
  | "skills"
  | "memory";

export type PromptCommand = {
  name: PromptCommandName;
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
    description: "Fork the current session and send a prompt.",
  },
  {
    name: "resume",
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
    name: "memory",
    description: "Compact saved memory.",
  },
];

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
      : undefined;
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
