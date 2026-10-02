export type Clock = () => number;

/** Tracks elapsed wall time for a transient TUI activity. */
export class ElapsedTimer {
  private startedAt?: number;
  private stoppedElapsedMs = 0;

  constructor(private readonly now: Clock = Date.now) {}

  get active(): boolean {
    return this.startedAt !== undefined;
  }

  start(): void {
    this.startedAt = this.now();
    this.stoppedElapsedMs = 0;
  }

  resume(): void {
    this.startedAt ??= this.now();
  }

  stop(): void {
    if (this.startedAt === undefined) {
      return;
    }

    this.stoppedElapsedMs += this.now() - this.startedAt;
    this.startedAt = undefined;
  }

  elapsedSeconds(): number {
    const elapsedMs =
      this.stoppedElapsedMs + (this.startedAt === undefined ? 0 : this.now() - this.startedAt);

    return Math.max(0, Math.floor(elapsedMs / 1_000));
  }
}
