import { randomUUID } from "node:crypto";

type KanaUserTaskStatus = "pending" | "done" | "returned";

export type KanaUserTask = {
  id: string;
  task: string;
  status: KanaUserTaskStatus;
  createdAt: Date;
  finishedAt?: Date;
};

export type KanaUserTaskSettlement = {
  task: KanaUserTask;
  response: string;
};

export class KanaUserTaskManager {
  private readonly tasks = new Map<string, KanaUserTask>();
  private readonly listeners = new Set<(settlement: KanaUserTaskSettlement) => void>();
  private readonly changeListeners = new Set<() => void>();

  create(task: string): KanaUserTask {
    const description = task.trim();
    if (!description || description.length > 4_000) {
      throw new Error("User task must contain between 1 and 4000 characters.");
    }
    const created: KanaUserTask = {
      id: `task_${randomUUID()}`,
      task: description,
      status: "pending",
      createdAt: new Date(),
    };
    this.tasks.set(created.id, created);
    this.emitChange();
    return structuredClone(created);
  }

  list(): KanaUserTask[] {
    return structuredClone([...this.tasks.values()]);
  }

  context(): KanaUserTask[] {
    return this.list();
  }

  done(taskId: string, result: string): KanaUserTask {
    return this.settle(taskId, "done", result);
  }

  returnToAgent(taskId: string, reason = ""): KanaUserTask {
    return this.settle(taskId, "returned", reason);
  }

  observe(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task?.status === "done" || task?.status === "returned") {
      this.tasks.delete(taskId);
    }
  }

  subscribe(listener: (settlement: KanaUserTaskSettlement) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeChanges(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
    this.changeListeners.clear();
    this.tasks.clear();
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) listener();
  }

  private settle(taskId: string, status: "done" | "returned", response: string): KanaUserTask {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "pending") {
      throw new Error(`User task ${taskId} is not pending.`);
    }
    const normalized = response.trim();
    if (status === "done" && !normalized) {
      throw new Error("Completed user task requires a result.");
    }
    if (normalized.length > 8_000) {
      throw new Error("User task response must not exceed 8000 characters.");
    }
    const settled: KanaUserTask = { ...task, status, finishedAt: new Date() };
    this.tasks.set(taskId, settled);
    const event: KanaUserTaskSettlement = { task: structuredClone(settled), response: normalized };
    for (const listener of this.listeners) listener(structuredClone(event));
    this.emitChange();
    return structuredClone(settled);
  }
}
