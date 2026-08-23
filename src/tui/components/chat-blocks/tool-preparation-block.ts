import { color, dim, truncateToWidth } from "../../render";
import type { Component } from "../../runtime";
import { tuiTheme } from "../../theme";
import { type Clock, ElapsedTimer } from "../../utils/elapsed-timer";

/** Shows one transient activity for all local tool calls in a streamed assistant message. */
export class ToolPreparationBlock implements Component {
  private readonly timer: ElapsedTimer;
  private prepared = false;
  private cachedWidth?: number;
  private cachedElapsedSeconds?: number;
  private cachedLine?: string;

  constructor(now: Clock = Date.now) {
    this.timer = new ElapsedTimer(now);
    this.timer.start();
  }

  hasActiveTimer(): boolean {
    return this.timer.active;
  }

  stopTimer(): void {
    this.timer.stop();
    this.invalidate();
  }

  /** Freeze the preparation in place once tool interaction begins (e.g. approval),
   * preserving the elapsed seconds and dropping the `(Esc to abort)` hint. */
  markPrepared(): void {
    if (this.prepared) {
      return;
    }
    this.prepared = true;
    this.timer.stop();
    this.invalidate();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedElapsedSeconds = undefined;
    this.cachedLine = undefined;
  }

  render(width: number, _availableHeight?: number): string[] {
    const elapsedSeconds = this.timer.elapsedSeconds();
    if (
      this.cachedLine !== undefined &&
      this.cachedWidth === width &&
      this.cachedElapsedSeconds === elapsedSeconds
    ) {
      return [this.cachedLine];
    }

    const label = this.prepared ? "Prepared tools" : "Preparing tools";
    const hint =
      this.prepared || !this.timer.active ? "" : color(" (Esc to abort)", tuiTheme.shortcutHint);
    const line = truncateToWidth(`${dim(`${label} (${elapsedSeconds}s)`)}${hint}`, width);

    this.cachedWidth = width;
    this.cachedElapsedSeconds = elapsedSeconds;
    this.cachedLine = line;
    return [line];
  }
}
