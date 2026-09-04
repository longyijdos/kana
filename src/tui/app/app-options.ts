import type { BundledTheme } from "shiki";
import type { ContextCheckpoint } from "@/agent";
import type { Message } from "@/core";
import type { BackgroundJobClient } from "@/jobs";
import type {
  ConversationSessionSnapshot,
  KanaLaunchMode,
  KanaMcpServerActivation,
  KanaNotificationConfig,
  KanaOAuthTokenStatus,
  KanaSessionMetadata,
  KanaTodoItem,
  KanaToolApprovalConfig,
  KanaToolApprovals,
  KanaTuiConfig,
  KanaUsageScope,
  KanaUsageSummary,
  LoadKanaSkillActivationsResult,
  WakeScheduler,
} from "@/kana";
import type { Logger } from "@/logging";
import type { ToolApprovalSource } from "../tools";
import type { ExternalToolsLoadResult } from "./external-tools-lifecycle-controller";
import type { MemoryCompactSummary, MemoryScope } from "./memory-compact-controller";
import type { TuiModelSettings } from "./model-selection";

type KanaTuiConversationCapabilities = {
  initialSession?: ConversationSessionSnapshot;
  getResumeSessionId: () => string | undefined;
  createNewSession: () => { id: string };
  forkSession: (
    messages: Message[],
    contextCheckpoint: ContextCheckpoint | undefined,
    prompt: string,
  ) => { id: string; todoState?: KanaTodoItem[] };
  listSessions: () => KanaSessionMetadata[];
  loadSession: (sessionId: string) => ConversationSessionSnapshot;
  deleteSession: (sessionId: string) => Promise<boolean> | boolean;
  goalMaxRounds: number;
  wakeScheduler?: WakeScheduler;
  getBackgroundJobs?: (sessionId: string) => BackgroundJobClient | undefined;
  disposeSession?: (
    sessionId: string,
    source: "session_disposal" | "shutdown",
    foregroundSettled: Promise<void>,
  ) => Promise<void>;
};

type KanaTuiSkillCapabilities = {
  load: () => LoadKanaSkillActivationsResult;
  saveEnabledGlobalNames: (names: string[]) => void;
};

type KanaTuiMemoryCapabilities = {
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
  ): Promise<KanaOAuthTokenStatus>;
  signOutServer?(serverId: string): Promise<KanaOAuthTokenStatus>;
  reload: (
    onProgress: (status: string) => void,
    signal: AbortSignal,
  ) => Promise<ExternalToolsLoadResult>;
};

type KanaTuiExternalToolsCapabilities = {
  load?: (
    onProgress: (status: string) => void,
    signal: AbortSignal,
  ) => Promise<ExternalToolsLoadResult>;
  mcp?: KanaTuiMcpManagementCapabilities;
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
    resolveToolSource?: (toolName: string) => ToolApprovalSource | undefined;
  };
  ui: {
    notification: KanaNotificationConfig;
    config?: KanaTuiConfig;
    syntaxTheme?: BundledTheme;
  };
  memory: KanaTuiMemoryCapabilities;
  usage: KanaTuiUsageCapabilities;
  models?: KanaTuiModelCapabilities;
  externalTools?: KanaTuiExternalToolsCapabilities;
  diagnostics?: {
    getLogger: () => Logger;
  };
  lifecycle?: {
    stop?: () => Promise<void> | void;
    forceStop?: () => void;
  };
};
