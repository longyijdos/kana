import { describe, expect, test } from "bun:test";
import { registerTuiProcessSignals, type TuiSignalProcess } from "../../src/tui/process-lifecycle";

describe("TUI process lifecycle", () => {
  test("maps the first process signal to one graceful shutdown", () => {
    const target = new FakeSignalProcess();
    const signals: string[] = [];
    const dispose = registerTuiProcessSignals((signal) => signals.push(signal), target);

    expect(target.listenerCount).toBe(3);
    target.emit("SIGTERM");
    target.emit("SIGINT");
    dispose();

    expect(signals).toEqual(["SIGTERM"]);
    expect(target.exitCode).toBe(143);
    expect(target.listenerCount).toBe(0);
  });

  test("can remove signal handlers without requesting shutdown", () => {
    const target = new FakeSignalProcess();
    const signals: string[] = [];
    const dispose = registerTuiProcessSignals((signal) => signals.push(signal), target);

    dispose();
    target.emit("SIGHUP");

    expect(signals).toEqual([]);
    expect(target.exitCode).toBeUndefined();
    expect(target.listenerCount).toBe(0);
  });
});

type SignalName = "SIGHUP" | "SIGINT" | "SIGTERM";

class FakeSignalProcess implements TuiSignalProcess {
  exitCode?: string | number;
  private readonly listeners = new Map<SignalName, Set<() => void>>();

  get listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }

  once(signal: SignalName, listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  off(signal: SignalName, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: SignalName): void {
    for (const listener of [...(this.listeners.get(signal) ?? [])]) {
      listener();
    }
  }
}
