import { describe, expect, test } from "bun:test";
import { AgentEventStream } from "../../src/agent";
import { KanaTuiApp } from "../../src/tui/app/app";
import { registerTuiProcessSignals, type TuiSignalProcess } from "../../src/tui/process-lifecycle";
import { stripAnsi } from "../../src/tui/render";
import { withAgentInboxForTest } from "../helpers/agent-inbox";
import { waitFor } from "../helpers/async-control";
import {
  createTuiAgentStub as createAgentStub,
  createTuiAppOptions as createOptions,
  createTerminalStub as createTerminal,
} from "./app-fixture";

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

describe("Kana TUI shutdown", () => {
  test("cancels the active Agent before running host shutdown once", async () => {
    const events: string[] = [];
    let releaseIdle!: () => void;
    const idle = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });
    let shutdownRender = "";
    let app!: KanaTuiApp;
    app = new KanaTuiApp(
      () =>
        withAgentInboxForTest({
          state: createAgentState(),
          abort() {
            events.push("agent.abort");
          },
          async waitForIdle() {
            events.push("agent.waitForIdle");
            await idle;
          },
        }) as never,
      {
        ...createTerminal(),
        stop: () => events.push("terminal.stop"),
      },
      {
        ...createOptions(),
        lifecycle: {
          stop: async () => {
            app.showShutdownStatus("Closing MCP servers... 0/1");
            shutdownRender = stripAnsi(
              (app as unknown as { layout: { render(width: number): string[] } }).layout
                .render(80)
                .join("\n"),
            );
            events.push("host.stop");
          },
        },
      },
    );

    const firstStop = app.stop();
    const secondStop = app.stop();

    expect(secondStop).toBe(firstStop);
    expect(events).toEqual(["agent.abort", "agent.waitForIdle"]);
    const stopping = stripAnsi(
      (app as unknown as { layout: { render(width: number): string[] } }).layout
        .render(80)
        .join("\n"),
    );
    expect(stopping).toContain("Shutting down Kana...");
    expect(stopping).toContain("test-model");

    releaseIdle();
    await firstStop;
    await app.waitForStop();

    expect(shutdownRender).toContain("Closing MCP servers... 0/1");
    expect(events).toEqual(["agent.abort", "agent.waitForIdle", "host.stop", "terminal.stop"]);
  });

  test("prints complete token usage without a monetary estimate on exit", async () => {
    let output = "";
    const app = new KanaTuiApp(
      () => createAgentStub(),
      {
        ...createTerminal(),
        write: (data) => {
          output += data;
        },
      },
      createOptions(),
    );
    const internal = app as unknown as {
      status: {
        recordUsage(usage: {
          promptTokens: number;
          completionTokens: number;
          totalTokens: number;
          promptCacheHitTokens?: number;
          promptCacheMissTokens?: number;
        }): void;
      };
    };

    internal.status.recordUsage({
      promptTokens: 30,
      completionTokens: 10,
      totalTokens: 40,
      promptCacheHitTokens: 20,
      promptCacheMissTokens: 10,
    });
    app.start();
    await app.stop();

    expect(output).toContain("Token usage: total=40 input=10 (+ 20 cached) output=10");
    expect(output).not.toContain("API cost");
  });

  test("uses the second Ctrl+C to force stop while graceful shutdown is pending", async () => {
    let handleInput!: (data: string) => void;
    let releaseShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    let forceStopCount = 0;
    const terminal = {
      ...createTerminal(),
      start: (onInput: (data: string) => void) => {
        handleInput = onInput;
      },
    };
    const app = new KanaTuiApp(() => createAgentStub(), terminal, {
      ...createOptions(),
      lifecycle: {
        stop: () => shutdown,
        forceStop: () => {
          forceStopCount += 1;
        },
      },
    });
    const internal = app as unknown as {
      layout: { render(width: number): string[] };
    };

    app.start();
    void app.stop();
    await Promise.resolve();

    expect(stripAnsi(internal.layout.render(80).join("\n"))).toContain(
      "Press Ctrl+C again to force quit.",
    );
    expect(forceStopCount).toBe(0);

    handleInput("\x03");
    expect(forceStopCount).toBe(1);

    releaseShutdown();
    await app.waitForStop();
  });

  for (const { keyName, input } of [
    { keyName: "Escape", input: "\x1b" },
    { keyName: "Ctrl+C", input: "\x03" },
  ]) {
    test(`${keyName} cancels MCP startup without exiting`, async () => {
      let handleInput!: (data: string) => void;
      let terminalStopCount = 0;
      const app = new KanaTuiApp(
        () => createAgentStub(),
        {
          ...createTerminal(),
          start: (onInput: (data: string) => void) => {
            handleInput = onInput;
          },
          stop: () => {
            terminalStopCount += 1;
          },
        },
        {
          ...createOptions(),
          externalTools: {
            load: (_onProgress, signal) =>
              new Promise((_, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
          },
        },
      );
      const internal = app as unknown as {
        transcript: { render(width: number): string[] };
      };

      app.start();
      handleInput(input);
      await waitFor(() =>
        stripAnsi(internal.transcript.render(80).join("\n")).includes("MCP startup cancelled."),
      );

      expect(terminalStopCount).toBe(0);
      handleInput("\x03");
      await app.waitForStop();
      expect(terminalStopCount).toBe(1);
    });
  }

  test("submits the initial prompt after MCP startup is cancelled", async () => {
    let handleInput!: (data: string) => void;
    const calls: Array<{ input: unknown; stream: AgentEventStream }> = [];
    const app = new KanaTuiApp(
      () =>
        withAgentInboxForTest({
          state: createAgentState(),
          abort() {},
          async waitForIdle() {},
          stream(input: unknown) {
            const stream = new AgentEventStream();
            calls.push({ input, stream });
            return stream;
          },
        }) as never,
      {
        ...createTerminal(),
        start: (onInput: (data: string) => void) => {
          handleInput = onInput;
        },
      },
      {
        ...createOptions(),
        launch: { initialPrompt: "Continue without MCP." },
        externalTools: {
          load: (_onProgress, signal) =>
            new Promise((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
        },
      },
    );

    app.start();
    handleInput("\x1b");
    await waitFor(() => calls.length === 1);

    expect(calls[0]?.input).toMatchObject({
      role: "user",
      content: "Continue without MCP.",
      provenance: { kind: "user_input" },
    });
    calls[0]?.stream.end({ type: "agent_end", reason: "stop", messages: [] });
    await app.stop();
  });

  test("clears a focused editor draft before idle Ctrl+C exits", async () => {
    let handleInput!: (data: string) => void;
    let terminalStopCount = 0;
    const terminal = {
      ...createTerminal(),
      start: (onInput: (data: string) => void) => {
        handleInput = onInput;
      },
      stop: () => {
        terminalStopCount += 1;
      },
    };
    const app = new KanaTuiApp(() => createAgentStub(), terminal, createOptions());
    const editor = (
      app as unknown as {
        editor: {
          attachImage(image: {
            mimeType: "image/png";
            data: string;
            width: number;
            height: number;
          }): void;
          getText(): string;
          hasDraft(): boolean;
          setText(value: string): void;
        };
      }
    ).editor;

    app.start();
    editor.setText("unfinished");
    editor.attachImage({ mimeType: "image/png", data: "eA==", width: 1, height: 1 });

    handleInput("\x03");

    expect(editor.getText()).toBe("");
    expect(editor.hasDraft()).toBe(false);
    expect(terminalStopCount).toBe(0);

    handleInput("\x03");
    await app.waitForStop();

    expect(terminalStopCount).toBe(1);
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

function createAgentState() {
  return {
    messages: [],
    model: {
      metadata: {
        provider: "test",
        model: "test-model",
        contextWindow: 1,
        maxOutputTokens: 1,
      },
    },
  };
}
