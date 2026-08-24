import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { ContextCheckpoint } from "@/agent";
import {
  createMessageIdentity,
  createUserMessage,
  type Message,
  type MessageId,
  type ToolCallContent,
  type ToolResultMessage,
} from "@/core";
import {
  formatKanaTodoWriteAcknowledgement,
  type KanaTodoItem,
  normalizeKanaTodoItems,
} from "../todo";
import {
  type AppendCompactionOptions,
  type AppendKanaSessionMessagesOptions,
  type AppendSnapshotOptions,
  assertContextCheckpointForAppend,
  contextCheckpointToEntry,
  createEntryId,
  createMessageEntry,
  type KanaSessionContextCompactionEntry,
  type KanaSessionMessageEntry,
  type KanaSessionMetadata,
  type KanaSessionTimelineEntry,
  type KanaSessionTodoStateEntry,
  type KanaSessionTurnEndEntry,
  type KanaSessionTurnOutcome,
  type KanaSessionTurnStartEntry,
  metadataToHeader,
  normalizeSessionTitle,
} from "./format";

const INTERRUPTED_TOOL_RESULT =
  "Kana was interrupted before this tool result was recorded. The tool may have completed; do not retry it automatically.";

type JournalState = {
  tailId: string | null;
  entryIds: Set<string>;
  turnIds: Set<string>;
  activeTurn?: KanaSessionTurnStartEntry;
  activeTurnMessages: Message[];
  messageIds: string[];
  logicalMessageIds: Set<MessageId>;
  compactionIds: Set<string>;
  todoToolCallIds: Set<string>;
  activeTurnTodoStates: Map<string, KanaTodoItem[]>;
};

export class KanaSessionJournal {
  // One journal instance owns the append position for an active session.
  // Cached ids avoid reparsing an increasingly large JSONL file per message.
  private readonly state: JournalState = {
    tailId: null,
    entryIds: new Set<string>(),
    turnIds: new Set<string>(),
    activeTurnMessages: [],
    messageIds: [],
    logicalMessageIds: new Set<MessageId>(),
    compactionIds: new Set<string>(),
    todoToolCallIds: new Set<string>(),
    activeTurnTodoStates: new Map<string, KanaTodoItem[]>(),
  };
  private fileCreated: boolean;
  private writeFailed = false;

  constructor(
    private readonly session: KanaSessionMetadata,
    timeline: readonly KanaSessionTimelineEntry[] = [],
  ) {
    this.fileCreated = existsSync(session.path);
    for (const entry of timeline) {
      this.applyEntry(entry);
    }
  }

  get activeTurnId(): string | undefined {
    return this.state.activeTurn?.turnId;
  }

  startTurn(
    turnId: string,
    messages: Extract<Message, { role: "user" }>[],
    options: AppendKanaSessionMessagesOptions = {},
  ): KanaSessionTimelineEntry[] {
    if (this.state.activeTurn) {
      throw new Error(
        `Cannot start session turn ${turnId}; turn ${this.state.activeTurn.turnId} is still open.`,
      );
    }
    if (!turnId) {
      throw new Error("Session turn id cannot be empty.");
    }

    const timestamp = options.timestamp ?? new Date().toISOString();
    const entries: KanaSessionTimelineEntry[] = [];
    let parentId = this.state.tailId;
    const startEntry: KanaSessionTurnStartEntry = {
      type: "turn_start",
      id: createEntryId(),
      parentId,
      timestamp,
      turnId,
      kind: "agent",
    };
    entries.push(startEntry);
    parentId = startEntry.id;

    for (const message of messages) {
      const entry = createMessageEntry(message, parentId, timestamp);
      entries.push(entry);
      parentId = entry.id;
    }

    this.appendEntries(entries, messages);
    return structuredClone(entries);
  }

  appendMessage(
    turnId: string,
    message: Message,
    options: AppendKanaSessionMessagesOptions = {},
  ): KanaSessionMessageEntry {
    this.assertActiveTurn(turnId);
    const entry = createMessageEntry(
      message,
      this.state.tailId,
      options.timestamp ?? new Date().toISOString(),
    );

    this.appendEntries([entry]);
    return structuredClone(entry);
  }

  appendCompaction(
    checkpoint: ContextCheckpoint,
    options: AppendCompactionOptions = {},
  ): KanaSessionContextCompactionEntry {
    assertContextCheckpointForAppend(checkpoint);
    if (options.turnId !== undefined) {
      this.assertActiveTurn(options.turnId);
    } else if (this.state.activeTurn) {
      throw new Error(
        `Session turn ${this.state.activeTurn.turnId} must own compactions written while it is open.`,
      );
    }
    if (checkpoint.createdAfterMessageCount !== this.state.messageIds.length) {
      throw new Error(
        "Context compaction must be journaled immediately after the messages it was created from.",
      );
    }

    const entry = contextCheckpointToEntry(
      checkpoint,
      this.state.tailId,
      this.state.messageIds,
      this.state.compactionIds,
    );
    this.appendEntries([entry]);
    return structuredClone(entry);
  }

  appendTodoState(
    turnId: string,
    toolCallId: string,
    items: readonly KanaTodoItem[],
    options: AppendKanaSessionMessagesOptions = {},
  ): KanaSessionTodoStateEntry {
    this.assertActiveTurn(turnId);
    if (!toolCallId) {
      throw new Error("Todo state tool call id cannot be empty.");
    }
    if (this.state.todoToolCallIds.has(toolCallId)) {
      throw new Error(`Todo state for tool call ${toolCallId} has already been persisted.`);
    }
    if (!findToolCall(this.state.activeTurnMessages, toolCallId, "todo_write")) {
      throw new Error(`Todo state references unknown todo_write call ${toolCallId}.`);
    }

    const entry: KanaSessionTodoStateEntry = {
      type: "todo_state",
      id: createEntryId(),
      parentId: this.state.tailId,
      timestamp: options.timestamp ?? new Date().toISOString(),
      toolCallId,
      items: normalizeKanaTodoItems(items),
    };
    this.appendEntries([entry]);
    return structuredClone(entry);
  }

  endTurn(
    turnId: string,
    outcome: KanaSessionTurnOutcome,
    options: AppendKanaSessionMessagesOptions = {},
  ): KanaSessionTurnEndEntry {
    this.assertActiveTurn(turnId);
    const entry: KanaSessionTurnEndEntry = {
      type: "turn_end",
      id: createEntryId(),
      parentId: this.state.tailId,
      timestamp: options.timestamp ?? new Date().toISOString(),
      turnId,
      outcome,
    };

    this.appendEntries([entry]);
    return structuredClone(entry);
  }

  appendSnapshot(
    messages: Message[],
    options: AppendSnapshotOptions = {},
  ): KanaSessionTimelineEntry[] {
    if (this.state.activeTurn) {
      throw new Error(
        `Cannot append a session snapshot while turn ${this.state.activeTurn.turnId} is open.`,
      );
    }

    const compactions = structuredClone(options.compactions ?? []);
    for (const checkpoint of compactions) {
      assertContextCheckpointForAppend(checkpoint);
    }
    compactions.sort(
      (left, right) => left.createdAfterMessageCount - right.createdAfterMessageCount,
    );

    if (messages.length === 0 && options.todoState === undefined) {
      const entries: KanaSessionContextCompactionEntry[] = [];
      let parentId = this.state.tailId;
      const knownCompactionIds = new Set(this.state.compactionIds);

      for (const checkpoint of compactions) {
        if (checkpoint.createdAfterMessageCount !== this.state.messageIds.length) {
          throw new Error(
            "Context compaction references messages that have not been persisted at this timeline position.",
          );
        }
        const entry = contextCheckpointToEntry(
          checkpoint,
          parentId,
          this.state.messageIds,
          knownCompactionIds,
        );
        entries.push(entry);
        parentId = entry.id;
        knownCompactionIds.add(entry.id);
      }

      this.appendEntries(entries);
      return structuredClone(entries);
    }

    const timestamp = options.timestamp ?? new Date().toISOString();
    const turnId = randomUUID();
    const entries: KanaSessionTimelineEntry[] = [];
    const messageIds = [...this.state.messageIds];
    const knownCompactionIds = new Set(this.state.compactionIds);
    let messageCount = messageIds.length;
    let parentId = this.state.tailId;
    let compactionIndex = 0;

    const startEntry: KanaSessionTurnStartEntry = {
      type: "turn_start",
      id: createEntryId(),
      parentId,
      timestamp,
      turnId,
      kind: "snapshot",
    };
    entries.push(startEntry);
    parentId = startEntry.id;

    const appendEligibleCompactions = (): void => {
      while (
        compactionIndex < compactions.length &&
        (compactions[compactionIndex]?.createdAfterMessageCount ?? Number.POSITIVE_INFINITY) <=
          messageCount
      ) {
        const checkpoint = compactions[compactionIndex];
        if (!checkpoint) {
          break;
        }
        if (checkpoint.createdAfterMessageCount < this.state.messageIds.length) {
          throw new Error("Context compaction predates the snapshot being appended.");
        }
        const entry = contextCheckpointToEntry(
          checkpoint,
          parentId,
          messageIds,
          knownCompactionIds,
        );
        entries.push(entry);
        parentId = entry.id;
        knownCompactionIds.add(entry.id);
        compactionIndex += 1;
      }
    };

    appendEligibleCompactions();
    for (const message of messages) {
      const entry = createMessageEntry(message, parentId, timestamp);
      entries.push(entry);
      parentId = entry.id;
      messageIds.push(entry.id);
      messageCount += 1;
      appendEligibleCompactions();
    }

    if (compactionIndex !== compactions.length) {
      throw new Error("Context compaction references messages that have not been persisted.");
    }

    if (options.todoState !== undefined) {
      const todoEntry: KanaSessionTodoStateEntry = {
        type: "todo_state",
        id: createEntryId(),
        parentId,
        timestamp,
        items: normalizeKanaTodoItems(options.todoState),
      };
      entries.push(todoEntry);
      parentId = todoEntry.id;
    }

    const endEntry: KanaSessionTurnEndEntry = {
      type: "turn_end",
      id: createEntryId(),
      parentId,
      timestamp,
      turnId,
      outcome: "snapshot",
    };
    entries.push(endEntry);

    this.appendEntries(entries, messages);
    return structuredClone(entries);
  }

  recoverInterruptedTurn(): {
    entries: KanaSessionTimelineEntry[];
    turnId: string;
    unknownToolCallCount: number;
  } {
    const activeTurn = this.state.activeTurn;
    if (!activeTurn) {
      throw new Error("Cannot recover a session without an interrupted turn.");
    }

    const unresolvedToolCalls = findUnresolvedToolCalls(this.state.activeTurnMessages);
    const timestamp = new Date().toISOString();
    const entries: KanaSessionTimelineEntry[] = [];
    let parentId = this.state.tailId;

    let unknownToolCallCount = 0;
    for (const toolCall of unresolvedToolCalls) {
      // A missing result cannot distinguish "never started" from "completed
      // before the process exited". Record an unknown outcome, never a retry.
      const acceptedTodoState = this.state.activeTurnTodoStates.get(toolCall.id);
      const isAcceptedTodoWrite = toolCall.name === "todo_write" && acceptedTodoState !== undefined;
      unknownToolCallCount += isAcceptedTodoWrite ? 0 : 1;
      const content = isAcceptedTodoWrite
        ? formatKanaTodoWriteAcknowledgement(acceptedTodoState)
        : INTERRUPTED_TOOL_RESULT;
      const message: ToolResultMessage = {
        ...createMessageIdentity({ kind: "tool_result" }),
        role: "tool",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content,
        result: isAcceptedTodoWrite
          ? { status: acceptedTodoState.length === 0 ? "cleared" : "updated" }
          : {
              status: "unknown",
              message: INTERRUPTED_TOOL_RESULT,
            },
        isError: !isAcceptedTodoWrite,
      };
      const entry = createMessageEntry(message, parentId, timestamp);
      entries.push(entry);
      parentId = entry.id;
    }

    const recoveryMessage = createMessageEntry(
      createUserMessage({
        provenance: { kind: "recovery" },
        content:
          unknownToolCallCount > 0
            ? `[Session recovery]\nThe previous agent run was interrupted. ${unknownToolCallCount} tool call outcome(s) are unknown and must not be retried automatically.`
            : "[Session recovery]\nThe previous agent run was interrupted. Continue only from messages that were fully recorded.",
      }),
      parentId,
      timestamp,
    );
    entries.push(recoveryMessage);
    parentId = recoveryMessage.id;

    const endEntry: KanaSessionTurnEndEntry = {
      type: "turn_end",
      id: createEntryId(),
      parentId,
      timestamp,
      turnId: activeTurn.turnId,
      outcome: "interrupted",
    };
    entries.push(endEntry);

    this.appendEntries(entries);
    return {
      entries: structuredClone(entries),
      turnId: activeTurn.turnId,
      unknownToolCallCount,
    };
  }

  private appendEntries(
    entries: readonly KanaSessionTimelineEntry[],
    titleMessages: readonly Message[] = [],
  ): void {
    if (entries.length === 0) {
      return;
    }
    if (this.writeFailed) {
      throw new Error("Kana session journal requires a reload after its previous write failed.");
    }
    if (this.fileCreated && !existsSync(this.session.path)) {
      throw new Error(`Kana session file disappeared while it was open: ${this.session.path}`);
    }
    if (!this.fileCreated && existsSync(this.session.path)) {
      throw new Error(`Kana session file was created by another writer: ${this.session.path}`);
    }
    this.assertLogicalMessageIdsAvailable(entries);

    const title = this.fileCreated
      ? this.session.title
      : normalizeSessionTitle(this.session.title, [...titleMessages]);
    const content = [
      ...(!this.fileCreated
        ? [
            JSON.stringify(
              metadataToHeader({
                ...this.session,
                title,
              }),
            ),
          ]
        : []),
      ...entries.map((entry) => JSON.stringify(entry)),
    ].join("\n");

    mkdirSync(path.dirname(this.session.path), { recursive: true });
    try {
      appendFileSync(this.session.path, `${content}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });

      this.session.title = title;
      this.fileCreated = true;
      for (const entry of entries) {
        this.applyEntry(entry);
      }
    } catch (error) {
      // appendFileSync can fail after a partial write. Poison this cached
      // writer so only a reload with tail recovery can resume the session.
      this.writeFailed = true;
      throw error;
    }
  }

  private applyEntry(entry: KanaSessionTimelineEntry): void {
    if (entry.parentId !== this.state.tailId) {
      throw new Error(
        `Kana session entry ${entry.id} does not follow parent ${this.state.tailId ?? "null"}.`,
      );
    }
    if (this.state.entryIds.has(entry.id)) {
      throw new Error(`Duplicate Kana session entry id: ${entry.id}`);
    }

    switch (entry.type) {
      case "turn_start":
        if (this.state.activeTurn) {
          throw new Error(
            `Kana session turn ${entry.turnId} started before turn ${this.state.activeTurn.turnId} ended.`,
          );
        }
        if (this.state.turnIds.has(entry.turnId)) {
          throw new Error(`Duplicate Kana session turn id: ${entry.turnId}`);
        }
        this.state.activeTurn = structuredClone(entry);
        this.state.activeTurnMessages = [];
        this.state.activeTurnTodoStates.clear();
        this.state.turnIds.add(entry.turnId);
        break;

      case "message":
        if (!this.state.activeTurn) {
          throw new Error(`Kana session message ${entry.id} is outside a turn.`);
        }
        if (this.state.logicalMessageIds.has(entry.message.id)) {
          throw new Error(`Duplicate Kana logical message id: ${entry.message.id}`);
        }
        this.state.messageIds.push(entry.id);
        this.state.logicalMessageIds.add(entry.message.id);
        this.state.activeTurnMessages.push(structuredClone(entry.message));
        break;

      case "context_compaction":
        if (!this.state.messageIds.includes(entry.coversThroughId)) {
          throw new Error(
            `Kana session compaction ${entry.id} references unknown message ${entry.coversThroughId}.`,
          );
        }
        if (
          entry.baseCompactionId !== undefined &&
          !this.state.compactionIds.has(entry.baseCompactionId)
        ) {
          throw new Error(
            `Kana session compaction ${entry.id} references unknown checkpoint ${entry.baseCompactionId}.`,
          );
        }
        this.state.compactionIds.add(entry.id);
        break;

      case "todo_state":
        if (!this.state.activeTurn) {
          throw new Error(`Kana session todo state ${entry.id} is outside a turn.`);
        }
        if (entry.toolCallId !== undefined) {
          if (this.state.todoToolCallIds.has(entry.toolCallId)) {
            throw new Error(`Duplicate Kana todo tool call id: ${entry.toolCallId}`);
          }
          if (!findToolCall(this.state.activeTurnMessages, entry.toolCallId, "todo_write")) {
            throw new Error(
              `Kana session todo state ${entry.id} references unknown todo_write call ${entry.toolCallId}.`,
            );
          }
          this.state.todoToolCallIds.add(entry.toolCallId);
          this.state.activeTurnTodoStates.set(entry.toolCallId, structuredClone(entry.items));
        }
        break;

      case "turn_end":
        this.assertActiveTurn(entry.turnId);
        this.state.activeTurn = undefined;
        this.state.activeTurnMessages = [];
        this.state.activeTurnTodoStates.clear();
        break;
    }

    this.state.entryIds.add(entry.id);
    this.state.tailId = entry.id;
  }

  private assertLogicalMessageIdsAvailable(entries: readonly KanaSessionTimelineEntry[]): void {
    const ids = new Set(this.state.logicalMessageIds);
    for (const entry of entries) {
      if (entry.type !== "message") {
        continue;
      }
      if (ids.has(entry.message.id)) {
        throw new Error(`Duplicate Kana logical message id: ${entry.message.id}`);
      }
      ids.add(entry.message.id);
    }
  }

  private assertActiveTurn(turnId: string): void {
    if (this.state.activeTurn?.turnId !== turnId) {
      throw new Error(
        this.state.activeTurn
          ? `Session turn ${this.state.activeTurn.turnId} is active, not ${turnId}.`
          : `Session turn ${turnId} is not active.`,
      );
    }
  }
}

export function createKanaSessionJournal(
  session: KanaSessionMetadata,
  timeline: readonly KanaSessionTimelineEntry[] = [],
): KanaSessionJournal {
  return new KanaSessionJournal(session, timeline);
}

function findUnresolvedToolCalls(messages: readonly Message[]): ToolCallContent[] {
  const unresolved = new Map<string, ToolCallContent>();

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const content of message.content) {
        if (content.type === "tool_call") {
          unresolved.set(content.id, structuredClone(content));
        }
      }
      continue;
    }
    if (message.role === "tool") {
      unresolved.delete(message.toolCallId);
    }
  }

  return [...unresolved.values()];
}

function findToolCall(
  messages: readonly Message[],
  toolCallId: string,
  toolName: string,
): ToolCallContent | undefined {
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const toolCall = message.content.find(
      (content): content is ToolCallContent =>
        content.type === "tool_call" && content.id === toolCallId && content.name === toolName,
    );
    if (toolCall) {
      return toolCall;
    }
  }
  return undefined;
}
