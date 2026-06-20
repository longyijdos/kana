import { describe, expect, test } from "bun:test";
import type { KanaNotificationConfig } from "@/kana";
import { NotificationController } from "../src/tui/app/notification-controller";
import type { Terminal, TerminalNotification } from "../src/tui/runtime";

class NotificationTerminal implements Pick<Terminal, "notify"> {
  readonly notifications: TerminalNotification[] = [];

  notify(notification: TerminalNotification): void {
    this.notifications.push(notification);
  }
}

const ENABLED_NOTIFICATION_CONFIG: KanaNotificationConfig = {
  backend: "bell",
  onAgentCompleted: true,
  onApprovalRequired: true,
};

describe("notification controller", () => {
  test("notifies when an agent stops normally", () => {
    const terminal = new NotificationTerminal();
    const controller = new NotificationController(ENABLED_NOTIFICATION_CONFIG, terminal);

    controller.handleAgentEvent({ type: "agent_end", reason: "stop", messages: [] });

    expect(terminal.notifications).toEqual([
      { title: "Kana", body: "Agent completed.", urgency: "normal" },
    ]);
  });

  test("does not report aborted, failed, or truncated runs as completed", () => {
    const terminal = new NotificationTerminal();
    const controller = new NotificationController(ENABLED_NOTIFICATION_CONFIG, terminal);

    controller.handleAgentEvent({ type: "agent_end", reason: "aborted", messages: [] });
    controller.handleAgentEvent({ type: "agent_end", reason: "error", messages: [] });
    controller.handleAgentEvent({ type: "agent_end", reason: "length", messages: [] });
    controller.handleAgentEvent({ type: "agent_start" });

    expect(terminal.notifications).toEqual([]);
  });

  test("respects completion and approval notification settings", () => {
    const terminal = new NotificationTerminal();
    const controller = new NotificationController(
      {
        ...ENABLED_NOTIFICATION_CONFIG,
        onAgentCompleted: false,
        onApprovalRequired: false,
      },
      terminal,
    );

    controller.handleAgentEvent({ type: "agent_end", reason: "stop", messages: [] });
    controller.approvalRequired("bash");

    expect(terminal.notifications).toEqual([]);
  });

  test("uses a critical notification for tool approval", () => {
    const terminal = new NotificationTerminal();
    const controller = new NotificationController(ENABLED_NOTIFICATION_CONFIG, terminal);

    controller.approvalRequired("bash");

    expect(terminal.notifications).toEqual([
      { title: "Kana", body: "Approval required for bash.", urgency: "critical" },
    ]);
  });
});
