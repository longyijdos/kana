import { formatPromptCommandUsage, type PromptSubmit } from "../components/editor/commands";

export type SlashCommand = Extract<PromptSubmit, { type: "command" }>;

export type SlashCommandControllerOptions = {
  isRunning: () => boolean;
  stop: () => void;
  submitRaw: (raw: string) => void;
  showError: (error: Error) => void;
  showHelp: () => void;
  clear: () => void;
  startNewSession: () => void;
  forkSession: (prompt: string) => void;
  resumeSession: (sessionId: string) => void;
  openResumePicker: () => void;
  openDeletePicker: () => void;
  openSkillManager: () => void;
  openMcpServerManager: () => void;
  openScheduledMessageManager: () => void;
  openBackgroundJobManager?: () => void;
  startGoal?: (objective: string) => void;
  openTodo?: () => void;
  openToolHistory: () => void;
  attachImageFile: (path: string) => void;
  openApproval: () => void;
  openModel: () => boolean;
  openMemory: () => void;
  compactContext: () => void;
  openUsage: () => void;
};

export class SlashCommandController {
  constructor(private readonly options: SlashCommandControllerOptions) {}

  handle(command: SlashCommand): void {
    if (this.options.isRunning() && command.name !== "quit") {
      return;
    }

    switch (command.name) {
      case "quit":
        if (command.arguments) {
          this.options.submitRaw(command.raw);
        } else {
          this.options.stop();
        }
        break;
      case "help":
        this.runWithoutArguments(command, () => this.options.showHelp());
        break;
      case "clear":
        if (command.arguments) {
          this.options.submitRaw(command.raw);
        } else {
          this.options.clear();
        }
        break;
      case "new":
        if (command.arguments) {
          this.options.submitRaw(command.raw);
        } else {
          this.options.startNewSession();
        }
        break;
      case "fork":
        if (!command.arguments) {
          this.showUsage(command);
        } else {
          this.options.forkSession(command.arguments);
        }
        break;
      case "resume":
        if (command.arguments) {
          this.options.resumeSession(command.arguments);
        } else {
          this.options.openResumePicker();
        }
        break;
      case "delete":
        this.runWithoutArguments(command, () => this.options.openDeletePicker());
        break;
      case "skills":
        this.runWithoutArguments(command, () => this.options.openSkillManager());
        break;
      case "mcp":
        this.runWithoutArguments(command, () => this.options.openMcpServerManager());
        break;
      case "schedule":
        this.runWithoutArguments(command, () => this.options.openScheduledMessageManager());
        break;
      case "jobs":
        this.runWithoutArguments(command, () => {
          if (this.options.openBackgroundJobManager) {
            this.options.openBackgroundJobManager();
          } else {
            this.options.showError(new Error("Background Job management is unavailable."));
          }
        });
        break;
      case "goal":
        if (!command.arguments) {
          this.showUsage(command);
        } else if (!this.options.startGoal) {
          this.options.showError(new Error("Goal continuation is unavailable."));
        } else {
          this.options.startGoal(command.arguments);
        }
        break;
      case "todo":
        this.runWithoutArguments(command, () => {
          if (this.options.openTodo) {
            this.options.openTodo();
          } else {
            this.options.showError(new Error("Todo viewer is unavailable."));
          }
        });
        break;
      case "tools":
        this.runWithoutArguments(command, () => this.options.openToolHistory());
        break;
      case "image":
        if (!command.arguments) {
          this.showUsage(command);
        } else {
          this.options.attachImageFile(command.arguments);
        }
        break;
      case "approval":
        this.runWithoutArguments(command, () => this.options.openApproval());
        break;
      case "model":
        this.runWithoutArguments(command, () => {
          if (!this.options.openModel()) {
            this.options.showError(new Error("Model management is unavailable."));
          }
        });
        break;
      case "memory":
        this.runWithoutArguments(command, () => this.options.openMemory());
        break;
      case "compact":
        this.runWithoutArguments(command, () => this.options.compactContext());
        break;
      case "usage":
        this.runWithoutArguments(command, () => this.options.openUsage());
        break;
    }
  }

  private runWithoutArguments(command: SlashCommand, action: () => void): void {
    if (command.arguments.trim()) {
      this.showUsage(command);
      return;
    }

    action();
  }

  private showUsage(command: SlashCommand): void {
    this.options.showError(new Error(formatPromptCommandUsage(command.name)));
  }
}
