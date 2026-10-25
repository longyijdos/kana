import { randomUUID } from "node:crypto";

type KanaGoalStatus = "active" | "completed" | "blocked" | "cancelled" | "round_limit";

export type KanaGoalSnapshot = {
  readonly id: string;
  readonly objective: string;
  readonly status: KanaGoalStatus;
  readonly admittedRounds: number;
  readonly maxRounds: number;
  readonly startedAt: Date;
  readonly endedAt?: Date;
  readonly detail?: string;
};

export type KanaGoalUpdate = {
  readonly status: "completed" | "blocked";
  readonly detail?: string;
};

export type KanaGoalContinuationAdmission =
  | { type: "admitted"; goal: KanaGoalSnapshot }
  | { type: "round_limit"; goal: KanaGoalSnapshot };

export class KanaGoalController {
  private goalData?: KanaGoalSnapshot;

  get current(): KanaGoalSnapshot | undefined {
    return this.goalData;
  }

  get active(): KanaGoalSnapshot | undefined {
    return this.goalData?.status === "active" ? this.goalData : undefined;
  }

  start(objective: string, maxRounds: number): KanaGoalSnapshot {
    if (this.goalData?.status === "active") {
      throw new Error("A goal is already active. Cancel it before starting another goal.");
    }
    if (!Number.isInteger(maxRounds) || maxRounds < 1) {
      throw new Error("Goal max rounds must be a positive integer.");
    }

    const normalizedObjective = normalizeText(objective, "Goal objective");
    this.goalData = {
      id: randomUUID(),
      objective: normalizedObjective,
      status: "active",
      admittedRounds: 1,
      maxRounds,
      startedAt: new Date(),
    };
    return this.goalData;
  }

  admitContinuation(): KanaGoalContinuationAdmission | undefined {
    if (this.goalData?.status !== "active") {
      return undefined;
    }
    if (this.goalData.admittedRounds >= this.goalData.maxRounds) {
      const goal = this.finish("round_limit", "The goal reached its round limit.");
      return { type: "round_limit", goal };
    }

    this.goalData = { ...this.goalData, admittedRounds: this.goalData.admittedRounds + 1 };
    return { type: "admitted", goal: this.goalData };
  }

  update(update: KanaGoalUpdate): KanaGoalSnapshot {
    if (this.goalData?.status !== "active") {
      throw new Error("There is no active goal to update.");
    }

    const detail =
      update.detail === undefined ? undefined : normalizeText(update.detail, "Goal detail", 2_000);
    return this.finish(update.status, detail);
  }

  cancel(detail = "Cancelled by the user."): KanaGoalSnapshot | undefined {
    return this.goalData?.status === "active" ? this.finish("cancelled", detail) : undefined;
  }

  block(detail: string): KanaGoalSnapshot | undefined {
    return this.goalData?.status === "active" ? this.finish("blocked", detail) : undefined;
  }

  /** Forgets a finished goal so it does not carry over into another session. */
  clear(): void {
    this.goalData = undefined;
  }

  discard(): KanaGoalSnapshot | undefined {
    if (this.goalData?.status !== "active") {
      return undefined;
    }
    const discarded = this.finish("cancelled", "Discarded after the execution context changed.");
    this.goalData = undefined;
    return discarded;
  }

  private finish(status: Exclude<KanaGoalStatus, "active">, detail?: string): KanaGoalSnapshot {
    if (!this.goalData) {
      throw new Error("Cannot finish a missing goal.");
    }
    this.goalData = {
      ...this.goalData,
      status,
      endedAt: new Date(),
      ...(detail === undefined ? {} : { detail }),
    };
    return this.goalData;
  }
}

function normalizeText(value: string, label: string, maxLength?: number): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must not be empty.`);
  }
  if (maxLength !== undefined && normalized.length > maxLength) {
    throw new Error(`${label} must contain between 1 and ${maxLength} characters.`);
  }
  return normalized;
}
