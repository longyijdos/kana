import type { AssistantMessage, Message } from "@/core";
import type { KanaSessionTimelineEntry } from "@/kana";

export type ServerEventType =
  | "snapshot"
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "session.changed"
  | "input.queue_changed"
  | "input.committed"
  | "todo.changed"
  | "goal.changed"
  | "assistant.started"
  | "assistant.delta"
  | "assistant.content"
  | "assistant.completed"
  | "model_turn.started"
  | "model_turn.completed"
  | "tool.started"
  | "tool.updated"
  | "tool.completed"
  | "tool.paused"
  | "tool.resumed"
  | "context.compaction_started"
  | "context.compacted"
  | "approval.required"
  | "approval.resolved";

export type ServerEvent = {
  schema_version: 1;
  type: ServerEventType;
  session_id: string | null;
  run_id: string | null;
  data: unknown;
};

export function projectMessage(message: Message) {
  if (message.role !== "assistant") return structuredClone(message);
  return {
    ...message,
    content: message.content.map(({ providerState: _providerState, ...content }) => content),
  };
}

export function projectTimelineEntry(entry: KanaSessionTimelineEntry) {
  return entry.type === "message"
    ? { ...entry, message: projectMessage(entry.message) }
    : structuredClone(entry);
}

export function projectAssistant(message: AssistantMessage) {
  return projectMessage(message);
}

export function projectError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}
