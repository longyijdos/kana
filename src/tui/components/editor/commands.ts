export type PromptCommandName = "quit" | "clear" | "new" | "fork";

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
    name: "clear",
    description: "Clear the transcript.",
  },
  {
    name: "new",
    description: "Start a new session.",
  },
  {
    name: "fork",
    description: "Fork the current session.",
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
    suggestions: PROMPT_COMMANDS.filter((command) =>
      command.name.startsWith(query),
    ),
  };
}

export function completeCommand(command: PromptCommand): string {
  return `/${command.name} `;
}

export function createCommandSubmit(
  value: string,
  selectedCommand: PromptCommand | undefined,
): PromptSubmit | undefined {
  const state = getCommandState(value);

  if (!state.isCommandMode) {
    return {
      type: "message",
      content: value,
    };
  }

  const command =
    PROMPT_COMMANDS.find((candidate) => candidate.name === state.query) ??
    selectedCommand;

  if (!command) {
    return undefined;
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
