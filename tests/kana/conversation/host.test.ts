import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "../../../src/agent";
import {
  ConversationRuntime,
  createKanaConversationHost,
  createKanaSession,
  createKanaSessionJournal,
  type KanaTodoItem,
  loadKanaSession,
} from "../../../src/kana";
import { MockModel } from "../../../src/providers/mock";
import { messageIdentityForTest } from "../../helpers/messages";

const temporaryHomes: string[] = [];
const originalKanaHome = process.env.KANA_HOME;

afterEach(() => {
  if (originalKanaHome === undefined) {
    delete process.env.KANA_HOME;
  } else {
    process.env.KANA_HOME = originalKanaHome;
  }
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("Kana conversation host", () => {
  test("shares Agent construction, journal persistence, accounting, and session logging", async () => {
    const env = createTempEnv();
    process.env.KANA_HOME = env.KANA_HOME;
    const host = createKanaConversationHost({
      env,
      createAgent: (_config, options = {}) =>
        new Agent({
          model: new MockModel({ provider: "mock", model: "mock", response: "Complete." }),
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
          journal: options.journal,
          logger: options.logger,
          onRunCommitted: options.onRunCommitted,
          onCompactionCommitted: options.onCompactionCommitted,
        }),
    });
    const runtime = createRuntime(host);
    runtime.setBeforeToolExecution(() => ({ type: "continue" }));

    await runtime.submit({
      ...messageIdentityForTest("user"),
      role: "user",
      content: "Run the task.",
    });

    const sessionId = host.resumeSessionId;
    expect(sessionId).toBeString();
    expect(
      loadKanaSession(sessionId ?? "", { cwd: process.cwd(), env }).messages.map(
        (message) => message.role,
      ),
    ).toEqual(["user", "assistant"]);

    await runtime.close();
    await host.close();
  });

  test("applies model changes atomically through the shared config store", async () => {
    const env = createTempEnv();
    const seenModels: string[] = [];
    const host = createKanaConversationHost<string>({
      env,
      applyAgentConfiguration: (config, model) => {
        config.agent.model.name = model;
      },
      createAgent: (config, options = {}) => {
        seenModels.push(config.agent.model.name);
        return new Agent({
          model: new MockModel({ provider: "mock", model: "mock" }),
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
        });
      },
    });
    const runtime = createRuntime(host);

    runtime.reconfigure("deepseek-v4-flash");

    expect(seenModels).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
    expect(host.config.agent.model.name).toBe("deepseek-v4-flash");
    await runtime.close();
    await host.close();
  });

  test("keeps clean sessions and model changes in memory", async () => {
    const env = createTempEnv();
    process.env.KANA_HOME = env.KANA_HOME;
    const seenModels: string[] = [];
    const host = createKanaConversationHost<string>({
      env,
      launchMode: "clean",
      applyAgentConfiguration: (config, model) => {
        config.agent.model.name = model;
      },
      createAgent: (config, options = {}) => {
        seenModels.push(config.agent.model.name);
        return new Agent({
          model: new MockModel({ provider: "mock", model: "mock", response: "Complete." }),
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
          journal: options.journal,
          logger: options.logger,
          onRunCommitted: options.onRunCommitted,
          onCompactionCommitted: options.onCompactionCommitted,
        });
      },
    });
    const runtime = createRuntime(host);
    runtime.setBeforeToolExecution(() => ({ type: "continue" }));

    runtime.reconfigure("deepseek-v4-flash");
    await runtime.submit({
      ...messageIdentityForTest("user"),
      role: "user",
      content: "Run the task.",
    });

    expect(seenModels).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
    expect(host.config.agent.model.name).toBe("deepseek-v4-flash");
    expect(host.resumeSessionId).toBeUndefined();
    expect(host.listSessions()).toEqual([]);
    expect(() => host.loadSession("saved-session")).toThrow(
      "Saved sessions are unavailable in clean mode.",
    );
    await expect(host.deleteSession("saved-session")).rejects.toThrow(
      "Saved sessions are unavailable in clean mode.",
    );
    expect(() => host.forkSession([], undefined, "Fork the task.")).toThrow(
      "Forking sessions is unavailable in clean mode.",
    );
    expect(() => host.loadUsage("session")).toThrow("Session usage is unavailable in clean mode.");
    expect(readdirSync(env.KANA_HOME ?? "", { recursive: true })).toEqual([]);

    await runtime.close();
    await host.close();
  });

  test("keeps customizations disabled across the clean host lifecycle", async () => {
    const env = createTempEnv();
    writeFileSync(path.join(env.KANA_HOME ?? "", "mcp.json"), "invalid MCP config");
    let mcpStartCount = 0;
    const seenLaunchModes: Array<string | undefined> = [];
    const host = createKanaConversationHost({
      env,
      launchMode: "clean",
      createAgent: (_config, options = {}) => {
        seenLaunchModes.push(options.launchMode);
        return new Agent({
          model: new MockModel({ provider: "mock", model: "mock" }),
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
        });
      },
      createMcpRuntime: (() => ({
        tools: [],
        diagnostics: [],
        selectedServerIds: [],
        start: async () => {
          mcpStartCount += 1;
          return { tools: [], diagnostics: [], selectedServerIds: [] };
        },
        reload: async () => ({ tools: [], diagnostics: [], selectedServerIds: [] }),
        close: async () => {},
        getToolSource: () => undefined,
      })) as never,
    });
    const sessionId = host.initialSession?.metadata.id;

    host.createAgent({ sessionId });
    const mcpSnapshot = await host.startMcp();

    expect(seenLaunchModes).toEqual(["clean"]);
    expect(mcpStartCount).toBe(0);
    expect(mcpSnapshot).toEqual({ tools: [], diagnostics: [], selectedServerIds: [] });
    expect(host.loadMcpServers()).toEqual([]);
    expect(() => host.loadMemory("global")).toThrow("Memory is unavailable in clean mode.");
    await expect(
      host.compactMemory("project", undefined, new AbortController().signal),
    ).rejects.toThrow("Memory is unavailable in clean mode.");

    await host.close();
  });

  test("copies todo state by value into a fork and persists it with the fork snapshot", async () => {
    const env = createTempEnv();
    const source = createKanaSession({ cwd: process.cwd(), env, id: "todo-source" });
    const todoState: KanaTodoItem[] = [
      { content: "Preserve the source plan", status: "in_progress" },
    ];
    createKanaSessionJournal(source).appendSnapshot([], { todoState });
    let resolveTodoState: (() => readonly KanaTodoItem[]) | undefined;
    const host = createKanaConversationHost({
      env,
      session: { type: "resume", sessionId: source.id },
      createAgent: (_config, options = {}) => {
        resolveTodoState = options.resolveTodoState;
        return new Agent({
          model: new MockModel({ provider: "mock", model: "mock", response: "Complete." }),
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
          journal: options.journal,
          onRunCommitted: options.onRunCommitted,
          onCompactionCommitted: options.onCompactionCommitted,
        });
      },
    });

    host.createAgent({ sessionId: source.id });
    expect(resolveTodoState?.()).toEqual(todoState);

    const fork = host.forkSession([], undefined, "Continue independently.");
    expect(fork.todoState).toEqual(todoState);
    fork.todoState[0]!.content = "Mutated return value";
    expect(resolveTodoState?.()).toEqual(todoState);

    const forkAgent = host.createAgent({ sessionId: fork.id });
    expect(resolveTodoState?.()).toEqual(todoState);
    await forkAgent.prompt("Continue the fork.");

    const loadedFork = host.loadSession(fork.id);
    expect(loadedFork.todoState).toEqual(todoState);
    expect(loadedFork.timeline.some((entry) => entry.type === "todo_state")).toBe(true);

    await host.close();
  });

  test("disposes temporary session artifacts when the runtime changes sessions", async () => {
    const env = createTempEnv();
    let saveArtifact: (() => Promise<{ locator: string }>) | undefined;
    const host = createKanaConversationHost({
      env,
      launchMode: "clean",
      createAgent: (_config, options = {}) => {
        if (options.artifactStore) {
          const artifactStore = options.artifactStore;
          saveArtifact = () => artifactStore.saveText("temporary output", "bash");
        }
        return new Agent({
          model: new MockModel({ provider: "mock", model: "mock" }),
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
        });
      },
    });
    const runtime = createRuntime(host);
    const artifact = await saveArtifact?.();

    expect(artifact).toBeDefined();
    expect(existsSync(artifact?.locator ?? "")).toBe(true);
    await runtime.startNewSession();
    expect(existsSync(artifact?.locator ?? "")).toBe(false);

    const shutdownArtifact = await saveArtifact?.();
    await runtime.close();
    expect(existsSync(shutdownArtifact?.locator ?? "")).toBe(true);
    await host.close();
    expect(existsSync(shutdownArtifact?.locator ?? "")).toBe(false);
  });

  test("waits for hosted background Jobs before reporting session deletion", async () => {
    const env = createTempEnv();
    const deletedSession = createKanaSession({ cwd: process.cwd(), env, id: "delete-hosted" });
    createKanaSessionJournal(deletedSession).appendSnapshot([
      {
        ...messageIdentityForTest("user"),
        role: "user",
        content: "Persist this session before deletion.",
      },
    ]);
    const host = createKanaConversationHost({ env });
    host.loadSession(deletedSession.id);
    const jobs = host.getBackgroundJobs(deletedSession.id);
    let canceled = false;
    jobs?.start({
      kind: "test",
      label: "pending cleanup",
      run: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              canceled = true;
              resolve({ status: "canceled", exitCode: null });
            },
            { once: true },
          );
        }),
    });

    expect(await host.deleteSession(deletedSession.id)).toBe(true);
    expect(canceled).toBe(true);
    expect(jobs?.list()).toEqual([]);
    expect(host.listSessions().some((session) => session.id === deletedSession.id)).toBe(false);

    await host.close();
  });

  test("disposes the previous hosted generation when resuming the same session ID", async () => {
    const env = createTempEnv();
    const session = createKanaSession({ cwd: process.cwd(), env, id: "same-id" });
    createKanaSessionJournal(session).appendSnapshot([
      {
        ...messageIdentityForTest("user"),
        role: "user",
        content: "Resume this exact session.",
      },
    ]);
    const host = createKanaConversationHost({
      env,
      session: { type: "resume", sessionId: session.id },
      createAgent: (_config, options = {}) =>
        new Agent({
          model: new MockModel({ provider: "mock", model: "mock" }),
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
        }),
    });
    const runtime = createRuntime(host);
    const previousJobs = host.getBackgroundJobs(session.id);
    let previousCanceled = false;
    previousJobs?.start({
      kind: "test",
      label: "previous generation",
      run: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              previousCanceled = true;
              resolve({ status: "canceled", exitCode: null });
            },
            { once: true },
          );
        }),
    });

    await runtime.resumeSession(session.id);
    const currentJobs = host.getBackgroundJobs(session.id);

    expect(previousCanceled).toBe(true);
    expect(currentJobs).not.toBe(previousJobs);
    expect(() =>
      currentJobs?.start({
        kind: "test",
        label: "current generation",
        run: async () => ({ status: "completed", exitCode: 0 }),
      }),
    ).not.toThrow();

    await runtime.close();
    await host.close();
  });
});

function createRuntime<TConfiguration>(
  host: ReturnType<typeof createKanaConversationHost<TConfiguration>>,
): ConversationRuntime<TConfiguration> {
  return new ConversationRuntime<TConfiguration>({
    initialSession: host.initialSession
      ? {
          id: host.initialSession.metadata.id,
          messages: host.initialSession.messages,
          timeline: host.initialSession.timeline,
          contextCheckpoint: host.initialSession.contextCheckpoint,
        }
      : undefined,
    createAgent: (options) => host.createAgent(options),
    createNewSession: () => host.createNewSession(),
    forkSession: (messages, contextCheckpoint, prompt) =>
      host.forkSession(messages, contextCheckpoint, prompt),
    loadSession: (sessionId) => {
      const session = host.loadSession(sessionId);
      return {
        id: session.metadata.id,
        messages: session.messages,
        timeline: session.timeline,
        contextCheckpoint: session.contextCheckpoint,
      };
    },
    listSessions: () => host.listSessions(),
    deleteSession: (sessionId) => host.deleteSession(sessionId),
    disposeSession: (sessionId, source, foregroundSettled) =>
      host.disposeSession(sessionId, source, foregroundSettled),
    wakeScheduler: host.wakeScheduler,
    goalMaxRounds: host.config.agent.goalMaxRounds,
    getLogger: () => host.getLogger(),
  });
}

function createTempEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), "kana-conversation-host-"));
  temporaryHomes.push(home);
  const kanaHome = path.join(home, ".kana");
  mkdirSync(kanaHome, { recursive: true });
  return {
    HOME: home,
    KANA_HOME: kanaHome,
  };
}
