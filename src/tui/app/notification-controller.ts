import type { AgentEvent } from "@/agent";
import type { KanaNotificationConfig } from "@/kana";
import type { Terminal } from "../runtime";

export class NotificationController {
  constructor(
    private readonly config: KanaNotificationConfig,
    private readonly terminal: Pick<Terminal, "notify">,
  ) {}

  handleAgentEvent(event: AgentEvent): void {
    if (event.type !== "agent_end" || event.reason !== "stop" || !this.config.onAgentCompleted) {
      return;
    }

    this.terminal.notify({
      title: "Kana",
      body: "Agent completed.",
      urgency: "normal",
    });
  }

  approvalRequired(toolName: string): void {
    if (!this.config.onApprovalRequired) {
      return;
    }

    this.terminal.notify({
      title: "Kana",
      body: `Approval required for ${toolName}.`,
      urgency: "critical",
    });
  }
}
