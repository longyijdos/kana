const SHUTDOWN_SIGNALS = [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const;

type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number][0];

export type TuiSignalProcess = {
  exitCode?: string | number;
  once(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
};

export function registerTuiProcessSignals(
  onSignal: (signal: ShutdownSignal) => void,
  processTarget: TuiSignalProcess = process as TuiSignalProcess,
): () => void {
  const listeners = new Map<ShutdownSignal, () => void>();
  let active = true;

  const dispose = (): void => {
    if (!active) {
      return;
    }

    active = false;
    for (const [signal, listener] of listeners) {
      processTarget.off(signal, listener);
    }
    listeners.clear();
  };

  for (const [signal, exitCode] of SHUTDOWN_SIGNALS) {
    const listener = (): void => {
      if (!active) {
        return;
      }

      // Remove every listener before starting asynchronous cleanup. A second
      // signal then keeps its normal force-termination behavior rather than
      // starting a competing shutdown sequence.
      processTarget.exitCode = exitCode;
      dispose();
      onSignal(signal);
    };
    listeners.set(signal, listener);
    processTarget.once(signal, listener);
  }

  return dispose;
}
