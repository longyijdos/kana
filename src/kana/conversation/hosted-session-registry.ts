import type { AgentJournal, ContextCheckpoint } from "@/agent";
import type { Message, ModelMetadata } from "@/core";
import { type BackgroundJobClient, BackgroundJobManager } from "@/jobs";
import { createNoopLogger, createSessionLogManager, type Logger, type LogLevel } from "@/logging";
import {
  auditKanaSessionArtifacts,
  cleanupOrphanedKanaSessionArtifacts,
  createPersistentKanaSessionArtifactStore,
  createTemporaryKanaSessionArtifactStore,
  deleteKanaSessionArtifacts,
  forkKanaSessionArtifacts,
  type KanaArtifactCleanupResult,
  type KanaSessionArtifactStore,
} from "../artifacts";
import type { KanaLaunchMode } from "../launch-mode";
import { getKanaSessionLogPath } from "../path";
import {
  createKanaSession,
  createKanaSessionJournal,
  deleteKanaSession,
  type KanaSessionJournal,
  type KanaSessionMetadata,
  type LoadKanaSessionResult,
  listKanaSessions,
  loadKanaSession,
} from "../session";
import type { KanaTodoItem, KanaTodoStateChange } from "../todo";

type HostedSessionSelection =
  | { type: "new" }
  | { type: "resume"; sessionId: string }
  | { type: "none" };

type HostedSessionIdentity = {
  id: string;
  cwd: string;
  persistent: boolean;
};

export type HostedSessionAgentBinding = {
  session?: HostedSessionIdentity;
  logger: Logger;
  messages?: Message[];
  contextCheckpoint?: ContextCheckpoint;
  artifactStore?: KanaSessionArtifactStore;
  backgroundJobs?: BackgroundJobClient;
  journal?: AgentJournal;
  resolveTodoState?: () => readonly KanaTodoItem[];
  commitTodoState: (change: KanaTodoStateChange) => void;
};

type HostedSessionDisposalSource = "session_disposal" | "shutdown";

type HostedSessionRegistryOptions = {
  env: NodeJS.ProcessEnv;
  launchMode: KanaLaunchMode;
  logLevel: LogLevel;
  getSessionModel: () => Pick<ModelMetadata, "provider" | "model">;
  getBackgroundJobMaxConcurrent: () => number;
};

type HostedSession = {
  data: LoadKanaSessionResult;
  artifactStore: KanaSessionArtifactStore;
  backgroundJobs: BackgroundJobClient;
  journal?: KanaSessionJournal;
  logger: Logger;
  persistent: boolean;
  pendingForkMessages?: Message[];
  pendingForkCheckpoint?: ContextCheckpoint;
  pendingForkTodoState?: KanaTodoItem[];
  disposal?: Promise<void>;
  artifactCleanup?: Promise<void>;
};

export class HostedSessionRegistry {
  private readonly logManager;
  private readonly backgroundJobManager = new BackgroundJobManager();
  private readonly sessions = new Map<string, HostedSession>();
  private readonly hostedSessions = new Set<HostedSession>();
  private readonly pendingDisposals = new Map<string, HostedSession[]>();
  private activeSession?: HostedSession;
  private resumableSessionId?: string;

  constructor(private readonly options: HostedSessionRegistryOptions) {
    this.logManager = createSessionLogManager({ level: options.logLevel });
  }

  get resumeSessionId(): string | undefined {
    return this.resumableSessionId;
  }

  get activeId(): string | undefined {
    return this.activeSession?.data.metadata.id;
  }

  initialize(selection: HostedSessionSelection): LoadKanaSessionResult | undefined {
    const initialSession = this.loadInitialSession(selection);
    if (this.options.launchMode !== "clean") {
      this.logArtifactCleanup(
        initialSession?.logger,
        "orphan_cleanup",
        cleanupOrphanedKanaSessionArtifacts({ cwd: process.cwd(), env: this.options.env }),
      );
    }
    return initialSession === undefined ? undefined : structuredClone(initialSession.data);
  }

  getLogger(): Logger {
    return this.activeSession?.logger ?? createNoopLogger();
  }

  getBackgroundJobs(sessionId: string): BackgroundJobClient | undefined {
    return this.sessions.get(sessionId)?.backgroundJobs;
  }

  getActiveSession(): HostedSessionIdentity | undefined {
    return this.activeSession === undefined ? undefined : createSessionIdentity(this.activeSession);
  }

  createAgentBinding(
    sessionId: string | undefined,
    onTodoStateCommitted?: (change: KanaTodoStateChange) => void,
  ): HostedSessionAgentBinding {
    if (sessionId === undefined) {
      return {
        logger: createNoopLogger(),
        commitTodoState: () => {
          throw new Error("Cannot update todo state without an active session.");
        },
      };
    }

    const hostedSession = this.sessions.get(sessionId);
    if (!hostedSession) {
      throw new Error(`Kana conversation host has no session ${sessionId}.`);
    }

    return {
      session: createSessionIdentity(hostedSession),
      logger: hostedSession.logger,
      messages: hostedSession.data.messages,
      contextCheckpoint: hostedSession.data.contextCheckpoint,
      artifactStore: hostedSession.artifactStore,
      backgroundJobs: hostedSession.backgroundJobs,
      journal:
        hostedSession.journal === undefined
          ? undefined
          : this.createAgentJournal(hostedSession, hostedSession.journal),
      resolveTodoState: () => structuredClone(hostedSession.data.todoState),
      commitTodoState: (change) =>
        this.commitTodoState(hostedSession, change, onTodoStateCommitted),
    };
  }

  activate(sessionId: string | undefined): void {
    const nextSession = sessionId === undefined ? undefined : this.sessions.get(sessionId);
    if (this.activeSession && this.activeSession !== nextSession) {
      const pending = this.pendingDisposals.get(this.activeSession.data.metadata.id) ?? [];
      pending.push(this.activeSession);
      this.pendingDisposals.set(this.activeSession.data.metadata.id, pending);
    }
    this.activeSession = nextSession;
  }

  createNewSession(): { id: string } {
    const hosted = this.registerSession({
      metadata: this.createSessionMetadata(),
      messages: [],
      timeline: [],
      todoState: [],
    });
    hosted.logger.info("session.created");
    return { id: hosted.data.metadata.id };
  }

  forkSession(
    messages: Message[],
    contextCheckpoint: ContextCheckpoint | undefined,
    prompt: string,
  ): { id: string; todoState: KanaTodoItem[] } {
    this.assertForkingAvailable();
    let source = this.activeSession;
    if (!source) {
      source = this.registerSession({
        metadata: this.createSessionMetadata(),
        messages: [],
        timeline: [],
        todoState: [],
      });
    }
    const metadata = this.createSessionMetadata(source.data.metadata.path, prompt);
    let forkedMessages = structuredClone(messages);
    let forkedCheckpoint = structuredClone(contextCheckpoint);
    if (source.persistent) {
      try {
        const forked = forkKanaSessionArtifacts({
          messages,
          contextCheckpoint,
          sourceSessionId: source.data.metadata.id,
          targetSessionId: metadata.id,
          cwd: source.data.metadata.cwd,
          env: this.options.env,
        });
        forkedMessages = forked.messages;
        forkedCheckpoint = forked.contextCheckpoint;
        if (forked.copiedArtifactCount > 0) {
          source.logger.info("session.artifact_forked", {
            artifactCount: forked.copiedArtifactCount,
          });
        }
      } catch (error) {
        source.logger.error("session.artifact_fork_failed", {
          phase: "copy",
          errorType: getErrorType(error),
          errorCode: getErrorCode(error),
        });
        throw error;
      }
    }
    const hosted = this.registerSession({
      metadata,
      messages: forkedMessages,
      timeline: [],
      todoState: structuredClone(source.data.todoState),
      contextCheckpoint: forkedCheckpoint,
    });
    if (hosted.persistent) {
      hosted.pendingForkMessages = structuredClone(forkedMessages);
      hosted.pendingForkCheckpoint =
        forkedCheckpoint === undefined
          ? undefined
          : {
              ...structuredClone(forkedCheckpoint),
              baseCompactionId: undefined,
            };
      hosted.pendingForkTodoState = structuredClone(source.data.todoState);
    }
    hosted.logger.info("session.forked", {
      sourceSessionId: source.data.metadata.id,
    });
    return {
      id: hosted.data.metadata.id,
      todoState: structuredClone(hosted.data.todoState),
    };
  }

  loadSession(sessionId: string): LoadKanaSessionResult {
    this.assertSavedSessionsAvailable();
    const hosted = this.registerSession(
      loadKanaSession(sessionId, { cwd: process.cwd(), env: this.options.env }),
    );
    this.logLoadedSession(hosted, "session.resumed");
    return structuredClone(hosted.data);
  }

  listSessions(): KanaSessionMetadata[] {
    if (this.options.launchMode === "clean") {
      return [];
    }
    return listKanaSessions({ cwd: process.cwd(), env: this.options.env });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    this.assertSavedSessionsAvailable();
    const hosted = this.sessions.get(sessionId);
    const deleted = deleteKanaSession(sessionId, {
      cwd: process.cwd(),
      env: this.options.env,
    });
    if (!deleted) {
      return false;
    }

    const disposals = await Promise.allSettled(
      [...this.hostedSessions]
        .filter((session) => session.data.metadata.id === sessionId)
        .map((session) => this.disposeHostedRecord(session, "session_disposal")),
    );
    for (const disposal of disposals) {
      if (disposal.status === "rejected") {
        (hosted?.logger ?? this.getLogger()).warn("session.cleanup_failed", {
          phase: "session_delete",
          errorType: getErrorType(disposal.reason),
          errorCode: getErrorCode(disposal.reason),
        });
      }
    }
    this.logArtifactCleanup(
      hosted?.logger ?? this.getLogger(),
      "session_delete",
      deleteKanaSessionArtifacts({
        sessionId,
        cwd: hosted?.data.metadata.cwd ?? process.cwd(),
        env: this.options.env,
      }),
    );
    this.sessions.delete(sessionId);
    this.pendingDisposals.delete(sessionId);
    if (this.activeSession?.data.metadata.id === sessionId) {
      this.activeSession = undefined;
    }
    return true;
  }

  async disposeSession(
    sessionId: string,
    source: HostedSessionDisposalSource,
    foregroundSettled: Promise<void> = Promise.resolve(),
  ): Promise<void> {
    const session = this.takePendingDisposal(sessionId) ?? this.sessions.get(sessionId);
    if (!session) {
      await foregroundSettled;
      return;
    }
    await this.disposeHostedRecord(session, source, foregroundSettled);
  }

  private async disposeHostedRecord(
    session: HostedSession,
    source: HostedSessionDisposalSource,
    foregroundSettled: Promise<void> = Promise.resolve(),
  ): Promise<void> {
    if (!session.disposal) {
      session.disposal = this.disposeHostedSession(session, source, foregroundSettled);
    } else {
      await foregroundSettled;
    }
    try {
      await session.disposal;
    } finally {
      if (source === "session_disposal") {
        await this.cleanupArtifactStore(session, source);
      }
    }
  }

  async close(foregroundSettled: Promise<void> = Promise.resolve()): Promise<void> {
    const sessions = [...this.hostedSessions];
    try {
      await Promise.all([this.backgroundJobManager.close(), foregroundSettled]);
    } finally {
      await Promise.all(sessions.map((session) => this.cleanupArtifactStore(session, "shutdown")));
    }
  }

  private loadInitialSession(selection: HostedSessionSelection): HostedSession | undefined {
    if (selection.type === "none") {
      return undefined;
    }
    if (selection.type === "resume") {
      this.assertSavedSessionsAvailable();
      const hosted = this.registerSession(
        loadKanaSession(selection.sessionId, {
          cwd: process.cwd(),
          env: this.options.env,
        }),
      );
      this.resumableSessionId = hosted.data.metadata.id;
      this.logLoadedSession(hosted, "session.started", { resumed: true });
      return hosted;
    }

    const hosted = this.registerSession({
      metadata: this.createSessionMetadata(),
      messages: [],
      timeline: [],
      todoState: [],
    });
    hosted.logger.info("session.started", {
      resumed: false,
      launchMode: this.options.launchMode,
    });
    return hosted;
  }

  private registerSession(data: LoadKanaSessionResult): HostedSession {
    const persistent = this.options.launchMode !== "clean";
    const logger = persistent
      ? this.logManager.forSession({
          path: getKanaSessionLogPath(data.metadata.id, {
            cwd: data.metadata.cwd,
            env: this.options.env,
          }),
          sessionId: data.metadata.id,
        })
      : createNoopLogger();
    // Temporary sessions retain normal identity but use process-scoped storage
    // so runtime correlation works without crossing the clean-mode boundary.
    const hosted: HostedSession = {
      data: structuredClone(data),
      artifactStore: persistent
        ? createPersistentKanaSessionArtifactStore({
            sessionId: data.metadata.id,
            cwd: data.metadata.cwd,
            env: this.options.env,
          })
        : createTemporaryKanaSessionArtifactStore(),
      backgroundJobs: this.backgroundJobManager.bind(
        this.backgroundJobManager.createOwner(data.metadata.id),
        {
          maxConcurrent: this.options.getBackgroundJobMaxConcurrent(),
          logger,
        },
      ),
      ...(persistent ? { journal: createKanaSessionJournal(data.metadata, data.timeline) } : {}),
      logger,
      persistent,
    };
    this.sessions.set(hosted.data.metadata.id, hosted);
    this.hostedSessions.add(hosted);
    if (persistent) {
      const audit = auditKanaSessionArtifacts({
        messages: hosted.data.messages,
        sessionId: hosted.data.metadata.id,
        cwd: hosted.data.metadata.cwd,
        env: this.options.env,
      });
      if (audit.missingCount > 0 || audit.invalidCount > 0) {
        hosted.logger.warn("session.artifact_references_invalid", {
          artifactCount: audit.artifactCount,
          missingCount: audit.missingCount,
          invalidCount: audit.invalidCount,
        });
      }
    }
    return hosted;
  }

  private createAgentJournal(
    hostedSession: HostedSession,
    journal: KanaSessionJournal,
  ): AgentJournal {
    return {
      startRun: ({ runId, messages }) => {
        if (hostedSession.pendingForkMessages) {
          const snapshotEntries = this.writeJournal(hostedSession, "snapshot", () =>
            journal.appendSnapshot(hostedSession.pendingForkMessages ?? [], {
              compactions: hostedSession.pendingForkCheckpoint
                ? [hostedSession.pendingForkCheckpoint]
                : [],
              todoState: hostedSession.pendingForkTodoState,
            }),
          );
          this.appendTimeline(hostedSession, snapshotEntries);
          hostedSession.pendingForkMessages = undefined;
          hostedSession.pendingForkCheckpoint = undefined;
          hostedSession.pendingForkTodoState = undefined;
        }

        const entries = this.writeJournal(hostedSession, "start", () =>
          journal.startTurn(runId, messages),
        );
        this.appendTimeline(hostedSession, entries);
        hostedSession.data.messages = [
          ...hostedSession.data.messages,
          ...structuredClone(messages),
        ];
        this.resumableSessionId = hostedSession.data.metadata.id;
      },
      appendMessage: ({ runId, message }) => {
        const entry = this.writeJournal(hostedSession, "message", () =>
          journal.appendMessage(runId, message),
        );
        this.appendTimeline(hostedSession, [entry]);
        hostedSession.data.messages = [...hostedSession.data.messages, structuredClone(message)];
      },
      appendCompaction: ({ runId, compaction }) => {
        const entry = this.writeJournal(hostedSession, "compaction", () =>
          journal.appendCompaction(compaction, { turnId: runId }),
        );
        this.appendTimeline(hostedSession, [entry]);
        hostedSession.data.contextCheckpoint = structuredClone(compaction);
      },
      endRun: ({ runId, reason }) => {
        const entry = this.writeJournal(hostedSession, "end", () => journal.endTurn(runId, reason));
        this.appendTimeline(hostedSession, [entry]);
      },
    };
  }

  private commitTodoState(
    hostedSession: HostedSession,
    { toolCallId, items }: KanaTodoStateChange,
    onTodoStateCommitted?: (change: KanaTodoStateChange) => void,
  ): void {
    const acceptedItems = structuredClone(items);
    const journal = hostedSession.journal;
    if (journal) {
      const turnId = journal.activeTurnId;
      if (!turnId) {
        throw new Error("Cannot update todo state outside an active session turn.");
      }
      const entry = this.writeJournal(hostedSession, "todo", () =>
        journal.appendTodoState(turnId, toolCallId, acceptedItems),
      );
      this.appendTimeline(hostedSession, [entry]);
    }
    hostedSession.data.todoState = structuredClone(acceptedItems);
    try {
      onTodoStateCommitted?.({
        toolCallId,
        items: structuredClone(acceptedItems),
      });
    } catch (error) {
      hostedSession.logger.warn("session.todo_state_notification_failed", {
        errorType: getErrorType(error),
        errorCode: getErrorCode(error),
      });
    }
    hostedSession.logger.debug("session.todo_state_committed", {
      itemCount: acceptedItems.length,
    });
  }

  private appendTimeline(
    hostedSession: HostedSession,
    entries: LoadKanaSessionResult["timeline"],
  ): void {
    hostedSession.data.timeline = [...hostedSession.data.timeline, ...entries];
  }

  private writeJournal<T>(
    hostedSession: HostedSession,
    phase: "start" | "message" | "compaction" | "todo" | "end" | "snapshot",
    operation: () => T,
  ): T {
    try {
      return operation();
    } catch (error) {
      hostedSession.logger.error("session.journal_write_failed", {
        phase,
        errorType: getErrorType(error),
        errorCode: getErrorCode(error),
      });
      throw error;
    }
  }

  private async disposeHostedSession(
    session: HostedSession,
    source: HostedSessionDisposalSource,
    foregroundSettled: Promise<void>,
  ): Promise<void> {
    const settlements = await Promise.allSettled([
      session.backgroundJobs.close(source),
      foregroundSettled,
    ]);
    const failure = settlements.find((settlement) => settlement.status === "rejected");
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
  }

  private cleanupArtifactStore(
    session: HostedSession,
    source: HostedSessionDisposalSource,
  ): Promise<void> {
    if (!session.artifactCleanup) {
      session.artifactCleanup = session.artifactStore.close().catch((error) => {
        session.logger.warn("session.artifact_cleanup_failed", {
          phase: source === "shutdown" ? "session_close" : "session_disposal",
          errorType: getErrorType(error),
          errorCode: getErrorCode(error),
        });
      });
    }
    return session.artifactCleanup;
  }

  private takePendingDisposal(sessionId: string): HostedSession | undefined {
    const pending = this.pendingDisposals.get(sessionId);
    const session = pending?.shift();
    if (pending?.length === 0) {
      this.pendingDisposals.delete(sessionId);
    }
    return session;
  }

  private logLoadedSession(
    hosted: HostedSession,
    event: string,
    metadata?: Record<string, unknown>,
  ): void {
    hosted.logger.info(event, {
      ...metadata,
      launchMode: this.options.launchMode,
    });
    if (hosted.data.recoveredInterruptedTurn) {
      hosted.logger.warn("session.interrupted_turn_recovered", {
        unknownToolCallCount: hosted.data.recoveredInterruptedTurn.unknownToolCallCount,
      });
    }
    if (hosted.data.recoveredIncompleteTail) {
      hosted.logger.warn("session.incomplete_tail_recovered");
    }
  }

  private logArtifactCleanup(
    logger: Logger | undefined,
    phase: "orphan_cleanup" | "session_delete",
    result: KanaArtifactCleanupResult,
  ): void {
    if (result.removedDirectoryCount > 0 || result.removedFileCount > 0) {
      logger?.info("session.artifact_cleaned", {
        phase,
        directoryCount: result.removedDirectoryCount,
        fileCount: result.removedFileCount,
      });
    }
    for (const failure of result.failures) {
      logger?.warn("session.artifact_cleanup_failed", {
        phase,
        ...failure,
      });
    }
  }

  private createSessionMetadata(parentSessionPath?: string, title?: string): KanaSessionMetadata {
    return createKanaSession({
      env: this.options.env,
      title,
      model: this.options.getSessionModel(),
      parentSessionPath,
    });
  }

  private assertSavedSessionsAvailable(): void {
    if (this.options.launchMode === "clean") {
      throw new Error("Saved sessions are unavailable in clean mode.");
    }
  }

  private assertForkingAvailable(): void {
    if (this.options.launchMode === "clean") {
      throw new Error("Forking sessions is unavailable in clean mode.");
    }
  }
}

function createSessionIdentity(session: HostedSession): HostedSessionIdentity {
  return {
    id: session.data.metadata.id,
    cwd: session.data.metadata.cwd,
    persistent: session.persistent,
  };
}

function getErrorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
