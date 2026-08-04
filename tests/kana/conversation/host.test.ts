import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "../../../src/agent";
import {
  ConversationRuntime,
  createKanaConversationHost,
  loadKanaSession,
} from "../../../src/kana";
import { MockModel } from "../../../src/providers/mock";

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

    await runtime.submit({ role: "user", content: "Run the task." });

    const sessionId = host.resumeSessionId;
    expect(sessionId).toBeString();
    expect(
      loadKanaSession(sessionId ?? "", { cwd: process.cwd(), env }).messages.map(
        (message) => message.role,
      ),
    ).toEqual(["user", "assistant"]);

    await runtime.close();
    await host.closeMcp();
  });

  test("applies model changes atomically through the shared config store", async () => {
    const env = createTempEnv();
    const seenModels: string[] = [];
    const host = createKanaConversationHost<string>({
      env,
      applyAgentConfiguration: (config, model) => {
        config.model.deepseek.name = model;
      },
      createAgent: (config, options = {}) => {
        seenModels.push(config.model.deepseek.name);
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
    expect(host.config.model.deepseek.name).toBe("deepseek-v4-flash");
    await runtime.close();
    await host.closeMcp();
  });

  test("keeps clean sessions and model changes in memory", async () => {
    const env = createTempEnv();
    process.env.KANA_HOME = env.KANA_HOME;
    const seenModels: string[] = [];
    const host = createKanaConversationHost<string>({
      env,
      launchMode: "clean",
      applyAgentConfiguration: (config, model) => {
        config.model.deepseek.name = model;
      },
      createAgent: (config, options = {}) => {
        seenModels.push(config.model.deepseek.name);
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
    await runtime.submit({ role: "user", content: "Run the task." });

    expect(seenModels).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
    expect(host.config.model.deepseek.name).toBe("deepseek-v4-flash");
    expect(host.resumeSessionId).toBeUndefined();
    expect(host.listSessions()).toEqual([]);
    expect(() => host.loadSession("saved-session")).toThrow(
      "Saved sessions are unavailable in clean mode.",
    );
    expect(() => host.deleteSession("saved-session")).toThrow(
      "Saved sessions are unavailable in clean mode.",
    );
    expect(() => host.loadUsage("session")).toThrow("Session usage is unavailable in clean mode.");
    expect(readdirSync(env.KANA_HOME ?? "", { recursive: true })).toEqual([]);

    await runtime.close();
    await host.closeMcp();
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

    await host.closeMcp();
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
    wakeScheduler: host.wakeScheduler,
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
