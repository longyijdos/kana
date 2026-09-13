import type { BackgroundJobSummary } from "@/jobs";
import type { KanaSubagentSummary } from "@/kana";

export type BackgroundClientStub<T> = {
  items: T[];
  list(): T[];
  subscribe(listener: (event?: unknown) => void): () => void;
  emit(event?: unknown): void;
  listenerCount(): number;
  close(source?: "session_disposal" | "shutdown"): Promise<void>;
};

export function createBackgroundClient<T>(): BackgroundClientStub<T> {
  const listeners = new Set<(event?: unknown) => void>();
  const items: T[] = [];

  return {
    items,
    list: () => [...items],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (event) => {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    listenerCount: () => listeners.size,
    close: async () => {},
  };
}

export function subagentSummary(
  id: string,
  status: KanaSubagentSummary["status"],
  label: string,
): KanaSubagentSummary {
  return {
    id,
    profile: "reviewer",
    label,
    status,
    startedAt: new Date(Date.UTC(2026, 8, 13, 10, 0, 0)),
  };
}

export function jobSummary(
  id: string,
  status: BackgroundJobSummary["status"],
  label: string,
): BackgroundJobSummary {
  return {
    id,
    kind: "bash",
    label,
    status,
    startedAt: new Date(Date.UTC(2026, 8, 13, 10, 0, 0)),
    exitCode: null,
  };
}
