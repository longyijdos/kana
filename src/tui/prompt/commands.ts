export type PromptCommandName = "quit";

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

  const body = value.slice(1);
  const commandTokenEnd = findCommandTokenEnd(value);
  const query = body.trimStart().split(/\s+/, 1)[0] ?? "";

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

export function getCommandSpan(value: string): { start: number; end: number } | undefined {
  if (!value.startsWith("/")) {
    return undefined;
  }

  return {
    start: 0,
    end: findCommandTokenEnd(value),
  };
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

  const rawName = state.query;
  const exactCommand = PROMPT_COMMANDS.find((command) => command.name === rawName);
  const command = exactCommand ?? selectedCommand;

  if (!command) {
    return undefined;
  }

  if (hasCommandArguments(value)) {
    return {
      type: "message",
      content: value,
    };
  }

  return {
    type: "command",
    name: command.name,
    raw: value,
  };
}

function findCommandTokenEnd(value: string): number {
  const match = /^\S+/.exec(value);

  return match ? match[0].length : value.length;
}

function hasCommandArguments(value: string): boolean {
  return value.slice(findCommandTokenEnd(value)).trim().length > 0;
}
