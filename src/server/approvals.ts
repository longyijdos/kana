import { randomUUID } from "node:crypto";
import type { BeforeToolExecutionHook, BeforeToolExecutionResult } from "@/agent";
import type { ToolCallContent } from "@/core";
import {
  type ConversationAgentIdentity,
  getShellCommand,
  type KanaToolApprovalConfig,
  type KanaToolApprovals,
  shouldRequestToolApproval,
} from "@/kana";

export type ApprovalDecision = "allow" | "reject" | "always" | "never";
export type ServerApproval = {
  id: string;
  session_id: string | null;
  agent: ConversationAgentIdentity;
  tool_call: { id: string; name: string; arguments: unknown };
  allow_always: boolean;
};

type PendingApproval = {
  public: ServerApproval;
  toolCall: ToolCallContent;
  resolve: (result: BeforeToolExecutionResult) => void;
  cleanup: () => void;
};

type ApprovalOptions = {
  getSessionId: () => string | undefined;
  getConfig: () => KanaToolApprovalConfig;
  getApprovals: () => KanaToolApprovals;
  addTrustedShellCommand: (command: string) => void;
  emit: (type: "approval.required" | "approval.resolved", data: unknown) => void;
};

export class ServerApprovals {
  private readonly pending = new Map<string, PendingApproval>();
  private temporaryNever = false;
  private closed = false;

  constructor(private readonly options: ApprovalOptions) {}

  get snapshot(): ServerApproval[] {
    return [...this.pending.values()].map((entry) => structuredClone(entry.public));
  }

  readonly request = (
    request: Parameters<BeforeToolExecutionHook>[0] & { agent: ConversationAgentIdentity },
  ): Promise<BeforeToolExecutionResult> | BeforeToolExecutionResult => {
    const { toolCall, signal, agent } = request;
    if (this.closed || signal?.aborted) return this.rejected();
    if (!this.requiresApproval(toolCall)) return { type: "continue" };
    return new Promise((resolve) => {
      const id = randomUUID();
      const onAbort = () => this.finish(id, "reject");
      const entry: PendingApproval = {
        public: {
          id,
          session_id: this.options.getSessionId() ?? null,
          agent: { ...agent },
          tool_call: {
            id: toolCall.id,
            name: toolCall.name,
            arguments: structuredClone(toolCall.args),
          },
          allow_always: getShellCommand(toolCall) !== undefined,
        },
        toolCall: structuredClone(toolCall),
        resolve,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      };
      this.pending.set(id, entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.options.emit("approval.required", structuredClone(entry.public));
    });
  };

  decide(id: string, decision: ApprovalDecision): "resolved" | "not_found" | "invalid" {
    const entry = this.pending.get(id);
    if (!entry) return "not_found";
    if (decision === "always" && !entry.public.allow_always) return "invalid";
    if (decision === "always") {
      this.options.addTrustedShellCommand(getShellCommand(entry.toolCall)!);
    }
    if (decision === "never") this.temporaryNever = true;
    this.finish(id, decision);
    if (decision === "always" || decision === "never") {
      for (const [pendingId, pending] of this.pending) {
        if (!this.requiresApproval(pending.toolCall)) this.finish(pendingId, "allow");
      }
    }
    return "resolved";
  }

  resetSession(): void {
    this.temporaryNever = false;
    for (const id of this.pending.keys()) this.finish(id, "reject");
  }

  close(): void {
    this.closed = true;
    this.resetSession();
  }

  private requiresApproval(toolCall: ToolCallContent): boolean {
    return shouldRequestToolApproval(
      this.temporaryNever ? { mode: "never" } : this.options.getConfig(),
      this.options.getApprovals(),
      toolCall,
    );
  }

  private finish(id: string, decision: ApprovalDecision): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.cleanup();
    this.options.emit("approval.resolved", { id, decision });
    entry.resolve(decision === "reject" ? this.rejected() : { type: "continue" });
  }

  private rejected(): BeforeToolExecutionResult {
    return { type: "cancel", abortRun: true, message: "Tool call rejected by user." };
  }
}
