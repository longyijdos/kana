import type { KanaMcpServerActivation, KanaOAuthTokenStatus } from "@/kana";
import type { Editor, StatusLineState, Transcript } from "../components";
import {
  type McpAuthAction,
  McpAuthActionMenu,
  type McpAuthActionMenuDecision,
  McpServerManager,
  type McpServerManagerDecision,
  type McpServerManagerItem,
  TextBlock,
} from "../components";
import { stripTerminalControlSequences } from "../render";
import type { Tui } from "../runtime";
import { tuiTheme } from "../theme";
import type { AppLayout } from "./app-layout";
import type { RunPhase } from "./status-phase";

export type McpServerManagerControllerOptions = {
  editor: Editor;
  layout: AppLayout;
  transcript: Transcript;
  tui: Tui;
  loadServers: () => KanaMcpServerActivation[];
  saveEnabledServerIds: (serverIds: string[]) => void;
  authorizeServer?(
    serverId: string,
    onAuthorizationUrl: (url: string) => void,
    signal: AbortSignal,
  ): Promise<KanaOAuthTokenStatus>;
  signOutServer?(serverId: string): Promise<KanaOAuthTokenStatus>;
  onClose: (changed: boolean) => void;
  updateStatus: (phase: RunPhase, extra?: Partial<StatusLineState>) => void;
  restoreBottom: (focus: boolean) => void;
};

export class McpServerManagerController {
  private activeManager?: McpServerManager;
  private activeAuthMenu?: McpAuthActionMenu;
  private servers: McpServerManagerItem[] = [];
  private authOperation?: { controller: AbortController; block: TextBlock; serverId: string };
  private reloadRequired = false;

  constructor(private readonly options: McpServerManagerControllerOptions) {}

  get active(): boolean {
    return this.activeManager !== undefined || this.activeAuthMenu !== undefined;
  }

  open(): void {
    if (this.activeManager) {
      return;
    }

    this.options.editor.clear();

    let servers: KanaMcpServerActivation[];
    try {
      servers = this.options.loadServers();
    } catch (error) {
      this.showError(error);
      this.options.restoreBottom(true);
      return;
    }

    this.servers = servers.map((server) =>
      server.type === "stdio"
        ? { ...server, args: server.args.slice() }
        : {
            ...server,
            ...(server.oauth === undefined ? {} : { oauth: { ...server.oauth } }),
          },
    );
    this.reloadRequired = false;
    const manager = new McpServerManager(this.servers, (decision) => this.finish(decision));
    this.activeManager = manager;
    this.options.layout.showBottom(manager);
    this.options.tui.setFocus(manager);
    this.options.tui.requestRender();
  }

  close(): void {
    this.cancelAuthOperation();
    this.closeInternal(false);
  }

  private finish(decision: McpServerManagerDecision): void {
    if (decision.type === "manage_auth") {
      this.openAuthMenu(decision.serverId);
      return;
    }

    if (!decision.changed && !this.reloadRequired) {
      this.closeInternal(false);
      return;
    }

    if (decision.changed) {
      try {
        this.options.saveEnabledServerIds(decision.enabledServerIds);
      } catch (error) {
        this.showError(error);
        return;
      }
    }

    this.closeInternal(true);
  }

  private openAuthMenu(serverId: string): void {
    const server = this.servers.find((candidate) => candidate.id === serverId);
    if (server?.type !== "http" || server.oauth === undefined || !this.activeManager) {
      return;
    }

    const menu = new McpAuthActionMenu(serverId, server.oauth, (decision) =>
      this.finishAuthAction(serverId, decision),
    );
    this.activeAuthMenu = menu;
    this.options.layout.showBottom(menu);
    this.options.tui.setFocus(menu);
    this.options.tui.requestRender();
  }

  private finishAuthAction(serverId: string, decision: McpAuthActionMenuDecision): void {
    if (decision.type === "back") {
      this.returnToManager();
      return;
    }
    if (decision.type === "cancel_operation") {
      this.cancelAuthOperation();
      return;
    }
    void this.runAuthAction(serverId, decision.action);
  }

  private async runAuthAction(serverId: string, action: McpAuthAction): Promise<void> {
    const menu = this.activeAuthMenu;
    const server = this.servers.find((candidate) => candidate.id === serverId);
    if (!menu || server?.type !== "http" || server.oauth === undefined || this.authOperation) {
      return;
    }

    const controller = new AbortController();
    const block = new TextBlock(formatAuthOperationStart(serverId, action), {
      color: tuiTheme.muted,
    });
    const operation = { controller, block, serverId };
    this.authOperation = operation;
    this.options.transcript.addChild(block);
    menu.setOperation(formatAuthMenuOperation(action));
    this.options.updateStatus("starting", { activeTool: undefined });
    this.options.tui.requestRender();

    try {
      const wasEnabled = server.enabled;
      const status = await this.runConfiguredAuthAction(
        serverId,
        action,
        operation,
        controller.signal,
      );
      if (this.authOperation !== operation) {
        return;
      }

      server.oauth = { type: "oauth2", ...status };
      if (action === "sign_out") {
        server.enabled = false;
        this.reloadRequired ||= wasEnabled;
        block.setText(
          `Signed out of MCP OAuth server ${sanitizeLabel(serverId)}. The server has been disabled.`,
        );
      } else {
        this.reloadRequired ||= server.enabled;
        block.setText(`MCP OAuth authorized: ${sanitizeLabel(serverId)}.`);
      }
      this.options.updateStatus("idle", { activeTool: undefined });
    } catch (error) {
      if (this.authOperation !== operation) {
        return;
      }
      if (controller.signal.aborted) {
        block.setText(`MCP OAuth authorization cancelled: ${sanitizeLabel(serverId)}.`);
        this.options.updateStatus("idle", { activeTool: undefined });
      } else {
        this.options.transcript.removeChild(block);
        this.showError(error);
      }
    } finally {
      if (this.authOperation === operation) {
        this.authOperation = undefined;
        menu.setOperation(undefined);
        this.returnToManager();
      }
    }
  }

  private runConfiguredAuthAction(
    serverId: string,
    action: McpAuthAction,
    operation: { controller: AbortController; block: TextBlock; serverId: string },
    signal: AbortSignal,
  ): Promise<KanaOAuthTokenStatus> {
    if (action === "sign_out") {
      if (this.options.signOutServer === undefined) {
        return Promise.reject(new Error("MCP OAuth sign-out is unavailable."));
      }
      return this.options.signOutServer(serverId);
    }
    if (this.options.authorizeServer === undefined) {
      return Promise.reject(new Error("MCP OAuth authorization is unavailable."));
    }
    return this.options.authorizeServer(
      serverId,
      (url) => {
        if (this.authOperation !== operation) {
          return;
        }
        operation.block.setText(formatAuthorizationUrl(serverId, url));
        this.options.tui.requestRender();
      },
      signal,
    );
  }

  private cancelAuthOperation(): void {
    const operation = this.authOperation;
    if (!operation) {
      return;
    }
    operation.block.setText(
      `MCP OAuth authorization cancelled: ${sanitizeLabel(operation.serverId)}.`,
    );
    operation.controller.abort(new Error("MCP OAuth authorization was cancelled."));
    this.options.tui.requestRender();
  }

  private returnToManager(): void {
    const manager = this.activeManager;
    if (!manager) {
      return;
    }
    this.activeAuthMenu = undefined;
    this.options.layout.showBottom(manager);
    this.options.tui.setFocus(manager);
    this.options.tui.requestRender();
  }

  private closeInternal(changed: boolean): void {
    const manager = this.activeManager;
    const authMenu = this.activeAuthMenu;
    if (!manager && !authMenu) {
      return;
    }

    const visible = authMenu && this.options.layout.isBottom(authMenu) ? authMenu : manager;
    const wasVisible = visible !== undefined && this.options.layout.isBottom(visible);
    const restoreFocus = visible !== undefined && this.options.tui.getFocus() === visible;
    this.activeManager = undefined;
    this.activeAuthMenu = undefined;
    this.authOperation = undefined;
    this.servers = [];

    if (wasVisible) {
      this.options.restoreBottom(restoreFocus);
    }
    this.options.onClose(changed);
  }

  private showError(error: unknown): void {
    this.options.transcript.addChild(
      new TextBlock(error instanceof Error ? error.message : String(error), {
        color: tuiTheme.error,
      }),
    );
    this.options.updateStatus("error", { activeTool: undefined });
    this.options.tui.requestRender();
  }
}

function formatAuthOperationStart(serverId: string, action: McpAuthAction): string {
  const label = sanitizeLabel(serverId);
  return action === "sign_out"
    ? `Signing out of MCP OAuth server ${label}...`
    : `Preparing OAuth authorization for MCP server ${label}...`;
}

function formatAuthMenuOperation(action: McpAuthAction): string {
  return action === "sign_out" ? "Signing out..." : "Waiting for browser authorization...";
}

function formatAuthorizationUrl(serverId: string, url: string): string {
  return [
    `Authorizing MCP server ${sanitizeLabel(serverId)} in your browser.`,
    "If the browser did not open, use this temporary URL:",
    url,
  ].join("\n");
}

function sanitizeLabel(value: string): string {
  return stripTerminalControlSequences(value).trim().replace(/\s+/g, " ");
}
