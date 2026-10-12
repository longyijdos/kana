import type { BundledTheme } from "shiki";
import type { ToolCallContent } from "@/core";
import type {
  ConversationRuntimeOptions,
  KanaLaunchMode,
  KanaMcpServerActivation,
  KanaNotificationConfig,
  KanaPromptTemplate,
  KanaToolApprovalConfig,
  KanaToolApprovals,
  KanaTuiConfig,
  KanaUsageScope,
  KanaUsageSummary,
  LoadKanaSkillActivationsResult,
  LoadKanaSubagentProfilesResult,
  MemoryConsolidationActivitySource,
} from "@/kana";
import type { Logger } from "@/logging";
import type { OAuthTokenStatus } from "@/oauth";
import type { ToolApprovalSource } from "../tools";
import type { McpLoadResult } from "./mcp-lifecycle-controller";
import type { MemoryCompactSummary, MemoryScope } from "./memory-compact-controller";
import type { TuiModelSelection, TuiModelSettings } from "./model-selection";

// Host-backed runtime callbacks plus the TUI's own session-picker needs. The
// TUI supplies createAgent itself so it can map model selections.
type KanaTuiConversationCapabilities = Omit<
  ConversationRuntimeOptions<TuiModelSelection>,
  "createAgent" | "listSessions" | "deleteSession" | "canStartQueuedRun"
> &
  Required<
    Pick<ConversationRuntimeOptions<TuiModelSelection>, "listSessions" | "deleteSession">
  > & {
    getResumeSessionId: () => string | undefined;
    loadSubagentProfiles?: () => LoadKanaSubagentProfilesResult;
  };
type KanaTuiSkillCapabilities = {
  load: () => LoadKanaSkillActivationsResult;
  saveEnabledGlobalNames: (names: string[]) => void;
};

type KanaTuiMemoryCapabilities = {
  activity?: MemoryConsolidationActivitySource;
  compact: (
    target: MemoryScope,
    userRequest: string | undefined,
    signal: AbortSignal,
  ) => Promise<MemoryCompactSummary[]>;
  load: (target: Exclude<MemoryScope, "both">) => string;
};

type KanaTuiUsageCapabilities = {
  load: (scope: KanaUsageScope) => KanaUsageSummary;
};

type KanaTuiModelCapabilities = {
  getSettings: () => TuiModelSettings;
};

type KanaTuiMcpManagementCapabilities = {
  loadServers: () => KanaMcpServerActivation[];
  saveEnabledServerIds: (serverIds: string[]) => void;
  authorizeServer?(
    serverId: string,
    onAuthorizationUrl: (url: string) => void,
    signal: AbortSignal,
  ): Promise<OAuthTokenStatus>;
  signOutServer?(serverId: string): Promise<OAuthTokenStatus>;
  reload: (onProgress: (status: string) => void, signal: AbortSignal) => Promise<McpLoadResult>;
};

type KanaTuiMcpCapabilities = {
  load?: (onProgress: (status: string) => void, signal: AbortSignal) => Promise<McpLoadResult>;
  management?: KanaTuiMcpManagementCapabilities;
};

export type KanaTuiAppOptions = {
  launch: {
    mode?: KanaLaunchMode;
    initialPrompt?: string;
    startInResumePicker?: boolean;
  };
  conversation: KanaTuiConversationCapabilities;
  skills: KanaTuiSkillCapabilities;
  toolApproval: {
    config: KanaToolApprovalConfig;
    approvals: KanaToolApprovals;
    addTrustedShellCommand: (command: string) => KanaToolApprovals;
    resolveToolSource?: (toolCall: ToolCallContent) => ToolApprovalSource | undefined;
  };
  ui: {
    notification: KanaNotificationConfig;
    config: KanaTuiConfig;
    promptTemplates?: readonly KanaPromptTemplate[];
    syntaxTheme?: BundledTheme;
  };
  memory: KanaTuiMemoryCapabilities;
  usage: KanaTuiUsageCapabilities;
  models?: KanaTuiModelCapabilities;
  mcp?: KanaTuiMcpCapabilities;
  diagnostics?: {
    getLogger: () => Logger;
  };
  lifecycle?: {
    stop?: () => Promise<void> | void;
    forceStop?: () => void;
  };
};
