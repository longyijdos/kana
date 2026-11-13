import type { ConversationScheduledInputCancellation, WakeEvent } from "@/kana";
import {
  ChoicePrompt,
  type Editor,
  ScheduledMessageManager,
  type ScheduledMessageManagerAction,
  type ScheduledMessageManagerItem,
  TextPrompt,
} from "../../components";
import { pad2, singleLine } from "../../render";
import type { Component, Tui } from "../../runtime";
import type { BottomAreaController } from "../bottom-area-controller";

type ScheduleDelayChoice = "5m" | "15m" | "30m" | "1h" | "custom";

export type ScheduledMessageManagerControllerOptions = {
  editor: Editor;
  bottomArea: BottomAreaController;
  tui: Tui;
  getSchedules: () => readonly WakeEvent[];
  schedule: (
    afterMinutes: number,
    message: string,
    options: { readonly repeat: boolean },
  ) => WakeEvent;
  cancel: (id: string) => ConversationScheduledInputCancellation;
  showError: (error: unknown) => void;
  collapseLongPastes?: boolean;
  onClose: () => void;
};

export class ScheduledMessageManagerController {
  private manager?: ScheduledMessageManager;
  private activeBottom?: Component;

  constructor(private readonly options: ScheduledMessageManagerControllerOptions) {}

  get active(): boolean {
    return this.manager !== undefined;
  }

  open(): void {
    if (this.manager) {
      return;
    }

    this.options.editor.clear();
    const manager = new ScheduledMessageManager((action) => this.handleAction(action));

    this.manager = manager;
    this.refresh();
    this.show(manager);
  }

  close(): void {
    if (!this.manager) {
      return;
    }

    const activeBottom = this.activeBottom;

    this.manager = undefined;
    this.activeBottom = undefined;
    if (activeBottom) {
      this.options.bottomArea.restore(activeBottom);
    }
    this.options.onClose();
  }

  private handleAction(action: ScheduledMessageManagerAction): void {
    switch (action.type) {
      case "add":
        this.showFrequencyChoices();
        break;
      case "delete":
        this.showDeleteConfirmation(action.item);
        break;
      case "refresh":
        this.refresh();
        break;
      case "close":
        this.close();
        break;
    }
  }

  private showFrequencyChoices(repeat = false): void {
    const prompt = new ChoicePrompt<"once" | "repeat">({
      title: "Schedule frequency",
      options: [
        { value: "once", label: "Once" },
        { value: "repeat", label: "Repeating" },
      ],
      defaultValue: repeat ? "repeat" : "once",
      onSelect: (choice) => this.showDelayChoices(choice === "repeat"),
      onCancel: () => this.returnToManager(),
    });
    this.show(prompt);
  }

  private showDelayChoices(repeat: boolean, defaultValue: ScheduleDelayChoice = "5m"): void {
    const prompt = new ChoicePrompt<ScheduleDelayChoice>({
      title: repeat ? "Repeat every" : "Schedule after",
      options: [
        { value: "5m", label: "5 minutes" },
        { value: "15m", label: "15 minutes" },
        { value: "30m", label: "30 minutes" },
        { value: "1h", label: "1 hour" },
        { value: "custom", label: "Custom…" },
      ],
      defaultValue,
      onSelect: (choice) => {
        if (choice === "custom") {
          this.showCustomDelay(repeat);
          return;
        }
        this.showMessagePrompt(parsePresetDelay(choice), choice, repeat);
      },
      onCancel: () => this.showFrequencyChoices(repeat),
    });

    this.show(prompt);
  }

  private showCustomDelay(repeat: boolean, initialValue = "", error?: string): void {
    const prompt = new TextPrompt({
      title: error ? `Custom delay · ${error}` : "Custom delay (1m–24h)",
      initialValue,
      placeholder: "Examples: 3m, 90m, 2h",
      collapseLongPastes: this.options.collapseLongPastes,
      onSubmit: (value) => {
        const result = parseCustomDelay(value);
        if (typeof result === "string") {
          this.showCustomDelay(repeat, value, result);
          return;
        }
        this.showMessagePrompt(result, "custom", repeat);
      },
      onCancel: () => this.showDelayChoices(repeat, "custom"),
    });

    this.show(prompt);
  }

  private showMessagePrompt(
    afterMinutes: number,
    delayChoice: ScheduleDelayChoice,
    repeat: boolean,
    initialValue = "",
    error?: string,
  ): void {
    const prompt = new TextPrompt({
      title: error ? `Scheduled message · ${error}` : "Scheduled message",
      initialValue,
      placeholder: "Message to send when the timer expires",
      collapseLongPastes: this.options.collapseLongPastes,
      onSubmit: (value) => {
        const message = value.trim();
        if (!message) {
          this.showMessagePrompt(afterMinutes, delayChoice, repeat, value, "message is required");
          return;
        }
        if (message.length > 4_000) {
          this.showMessagePrompt(
            afterMinutes,
            delayChoice,
            repeat,
            value,
            "maximum 4000 characters",
          );
          return;
        }

        try {
          const event = this.options.schedule(afterMinutes, message, { repeat });
          this.returnToManager();
          this.refresh(
            `Scheduled for ${formatLocalTimestamp(event.dueAt)}.${repeat ? ` Repeats every ${afterMinutes} minutes.` : ""}`,
          );
        } catch (scheduleError) {
          this.options.showError(scheduleError);
          this.returnToManager();
          this.refresh();
        }
      },
      onCancel: () => this.showDelayChoices(repeat, delayChoice),
    });

    this.show(prompt);
  }

  private showDeleteConfirmation(item: ScheduledMessageManagerItem): void {
    const prompt = new ChoicePrompt<"no" | "yes">({
      title: "Delete scheduled message?",
      detail: [
        `${formatLocalTimestamp(item.dueAt)} · ${item.origin === "agent" ? "Kana" : "you"}`,
        ...(item.everyMinutes === undefined ? [] : [`Repeats every ${item.everyMinutes} minutes`]),
        "Already queued messages are unaffected.",
        singleLine(item.message),
      ].join("\n"),
      options: [
        { value: "no", label: "No, keep it" },
        { value: "yes", label: "Yes, delete" },
      ],
      defaultValue: "no",
      onSelect: (decision) => {
        if (decision === "no") {
          this.returnToManager();
          return;
        }

        let result: ConversationScheduledInputCancellation;
        try {
          result = this.options.cancel(item.id);
        } catch (cancelError) {
          this.options.showError(cancelError);
          this.returnToManager();
          this.refresh();
          return;
        }

        this.returnToManager();
        this.refresh(
          result === "not_found"
            ? "Task already changed or removed."
            : "Scheduled message deleted.",
        );
      },
      onCancel: () => this.returnToManager(),
    });

    this.show(prompt);
  }

  private refresh(notice?: string): void {
    const manager = this.manager;
    if (!manager) {
      return;
    }

    try {
      manager.replaceItems(
        this.options.getSchedules().map((event) => ({
          id: event.id,
          dueAt: event.dueAt,
          origin: event.origin,
          message: event.message,
          everyMinutes: event.everyMinutes,
        })),
        notice,
      );
    } catch (error) {
      this.options.showError(error);
      manager.replaceItems([], "Unable to load scheduled messages.");
    }
    this.options.tui.requestRender();
  }

  private show(component: Component): void {
    if (!this.manager) {
      return;
    }
    this.activeBottom = component;
    this.options.bottomArea.show(component);
  }

  private returnToManager(): void {
    if (this.manager) {
      this.show(this.manager);
    }
  }
}

function parsePresetDelay(choice: Exclude<ScheduleDelayChoice, "custom">): number {
  return choice.endsWith("h") ? Number.parseInt(choice, 10) * 60 : Number.parseInt(choice, 10);
}

function parseCustomDelay(value: string): number | string {
  const match = /^(\d+)\s*([mh])$/i.exec(value.trim());
  if (!match) {
    return "use a value such as 3m, 90m, or 2h";
  }

  const amount = Number(match[1]);
  const minutes = match[2]?.toLowerCase() === "h" ? amount * 60 : amount;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1_440) {
    return "must be between 1 minute and 24 hours";
  }
  return minutes;
}

function formatLocalTimestamp(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${[
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ]
    .map(pad2)
    .join(":")}`;
}
