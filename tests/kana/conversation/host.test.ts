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
  type MemoryConsolidationActivity,
  type MemoryConsolidationEvent,
} from "../../../src/kana";
import type { KanaAgentOptions } from "../../../src/kana/agent";
import { createRememberTool, createTodoWriteTool } from "../../../src/kana/tools";
import { MockModel } from "../../../src/providers/mock";
import { waitFor } from "../../helpers/async-control";
import { ControlledModel } from "../../helpers/controlled-model";
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
  test("carries TUI theme configuration without resolving theme files", async () => {
    const env = createTempEnv();
    writeFileSync(path.join(env.KANA_HOME ?? "", "config.toml"), '[tui]\ntheme = "ocean"\n');

    const host = createKanaConversationHost({ env, session: { type: "none" } });

    expect(host.tuiConfig.theme).toBe("ocean");
    await host.close();
  });

  test("keeps the startup AGENTS.md instruction snapshot", async () => {
    const env = createTempEnv();
    const agentsPath = path.join(env.KANA_HOME ?? "", "AGENTS.md");
    writeFileSync(agentsPath, "Initial global instructions.\n");
    const seenInstructions: string[][] = [];
    const host = createKanaConversationHost({
      env,
      createAgent: (_config, options = {}) => {
        seenInstructions.push(options.instructionSections?.map((section) => section.content) ?? []);
        return new Agent({
          model: new MockModel({ provider: "mock", model: "mock" }),
          messages: options.messages,
        });
      },
    });
    const sessionId = host.initialSession?.metadata.id;

    writeFileSync(agentsPath, "Updated global instructions.\n");
    host.createAgent({ sessionId });
    writeFileSync(agentsPath, "Updated again.\n");
    host.createAgent({ sessionId });

    expect(seenInstructions).toHaveLength(2);
    for (const instructions of seenInstructions) {
      expect(instructions.some((content) => content.includes("Initial global instructions."))).toBe(
        true,
      );
      expect(instructions.some((content) => content.includes("Updated global instructions."))).toBe(
        false,
      );
    }
    await host.close();
  });

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
      configOverrides: ['agent.model.name="startup-model"', "agent.max_turns=50"],
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

    runtime.reconfigure("deepseek-v4-pro");

    expect(seenModels).toEqual(["startup-model", "deepseek-v4-pro"]);
    expect(host.config.agent.model.name).toBe("deepseek-v4-pro");
    expect(host.config.agent.maxTurns).toBe(50);
    await runtime.close();
    await host.close();
  });

  test.each([
    ["off", false],
    ["only", false],
    ["only", true],
  ] as const)(
    "schedules remember after commit (mode=%s, scriptError=%s)",
    async (codemode, scriptError) => {
      const env = createTempEnv();
      process.env.KANA_HOME = env.KANA_HOME;
      const model = new ControlledModel();
      const host = createKanaConversationHost({
        env,
        configOverrides: [
          `agent.codemode="${codemode}"`,
          'memory.agent.model.provider="custom"',
          'memory.agent.model.name="missing-model"',
        ],
        createAgent: (config, options = {}) =>
          new Agent({
            model,
            codemode: config.agent.codemode,
            tools: [createRememberTool({ env, onRecorded: options.onMemoryRecorded })],
            messages: options.messages,
            beforeToolExecution: options.beforeToolExecution,
            journal: options.journal,
            logger: options.logger,
            onRunCommitted: options.onRunCommitted,
          }),
      });
      const snapshots: MemoryConsolidationActivity[][] = [];
      const failures: MemoryConsolidationEvent[] = [];
      host.subscribeMemoryActivity((event) => {
        if (event.type === "activity_changed") snapshots.push(host.getMemoryActivity());
        else failures.push(event);
      });
      const runtime = createRuntime(host);
      runtime.setBeforeToolExecution(() => ({ type: "continue" }));
      try {
        const run = runtime.submit({
          ...messageIdentityForTest("user"),
          role: "user",
          content: "Remember this preference.",
        });
        await waitFor(() => model.requests.length === 1);
        model.requests[0]!.complete(
          [
            {
              type: "tool_call",
              id: "remember-preference",
              name: codemode === "off" ? "remember" : "run_code",
              args:
                codemode === "off"
                  ? { scope: "project", content: "Use Bun." }
                  : {
                      code:
                        'await tools.remember({ scope: "project", content: "Use Bun." }); ' +
                        (scriptError
                          ? 'throw new Error("after remembering");'
                          : 'return "recorded";'),
                    },
            },
          ],
          "toolUse",
        );
        await waitFor(() => model.requests.length === 2);
        expect(snapshots).toEqual([]);
        model.requests[1]!.complete("Saved.");
        await run;
        await waitFor(() => failures.length === 1 && host.getMemoryActivity().length === 0);

        expect(snapshots).toEqual([
          [{ scope: "project", status: "queued" }],
          [{ scope: "project", status: "organizing" }],
          [],
        ]);
        expect(failures[0]).toMatchObject({ type: "failed", scope: "project" });
        expect(
          (failures[0] as Extract<MemoryConsolidationEvent, { type: "failed" }>).error,
        ).toContain("Custom provider configuration was not found");
        const saved = loadKanaSession(host.resumeSessionId!, { env, cwd: process.cwd() });
        expect(
          saved.messages
            .filter((message) => message.role === "tool")
            .map((message) => message.toolName),
        ).toEqual([codemode === "off" ? "remember" : "run_code"]);

        const nextRun = runtime.submit({
          ...messageIdentityForTest("user"),
          role: "user",
          content: "Continue.",
        });
        await waitFor(() => model.requests.length === 3);
        model.requests[2]!.complete("Continued.");
        await nextRun;
        expect(failures).toHaveLength(1);
        expect(snapshots).toHaveLength(3);
      } finally {
        await runtime.close();
        await host.close();
      }
    },
  );

  test.each([false, true])(
    "persists nested todo updates without child messages (scriptError=%s)",
    async (scriptError) => {
      const env = createTempEnv();
      const model = new ControlledModel();
      const host = createKanaConversationHost({
        env,
        configOverrides: ['agent.codemode="only"'],
        createAgent: (config, options = {}) =>
          new Agent({
            model,
            codemode: config.agent.codemode,
            tools: [createTodoWriteTool({ commit: options.commitTodoState })],
            messages: options.messages,
            beforeToolExecution: options.beforeToolExecution,
            journal: options.journal,
            onRunCommitted: options.onRunCommitted,
          }),
      });
      const runtime = createRuntime(host);
      runtime.setBeforeToolExecution(() => ({ type: "continue" }));
      const items: KanaTodoItem[] = [{ content: "Resume work", status: "in_progress" }];
      try {
        const run = runtime.submit({
          ...messageIdentityForTest("user"),
          role: "user",
          content: "Track the work.",
        });
        await waitFor(() => model.requests.length === 1);
        model.requests[0]!.complete(
          [
            {
              type: "tool_call",
              id: "outer-todo",
              name: "run_code",
              args: {
                code: [
                  'await tools.todo_write({ items: [{ content: "Draft plan", status: "pending" }] });',
                  'await tools.todo_write({ items: [{ content: "Resume work", status: "in_progress" }] });',
                  scriptError ? 'throw new Error("after updating todo");' : 'return "tracked";',
                ].join("\n"),
              },
            },
          ],
          "toolUse",
        );
        await waitFor(() => model.requests.length === 2);
        model.requests[1]!.complete("Tracked.");
        await run;
        const saved = loadKanaSession(host.resumeSessionId!, { env, cwd: process.cwd() });
        expect(saved.todoState).toEqual(items);
        const changes = saved.timeline.filter((entry) => entry.type === "todo_state");
        expect(changes).toHaveLength(2);
        expect(changes.map((entry) => entry.parentToolCallId)).toEqual([
          "outer-todo",
          "outer-todo",
        ]);
        expect(new Set(changes.map((entry) => entry.toolCallId)).size).toBe(2);
        const results = saved.messages.filter((message) => message.role === "tool");
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
          toolCallId: "outer-todo",
          toolName: "run_code",
          isError: scriptError,
        });

        const clear = runtime.submit({
          ...messageIdentityForTest("user"),
          role: "user",
          content: "Clear the list.",
        });
        await waitFor(() => model.requests.length === 3);
        model.requests[2]!.complete(
          [
            {
              type: "tool_call",
              id: "outer-clear",
              name: "run_code",
              args: { code: "await tools.todo_write({ items: [] });" },
            },
          ],
          "toolUse",
        );
        await waitFor(() => model.requests.length === 4);
        model.requests[3]!.complete("Cleared.");
        await clear;
        expect(
          loadKanaSession(host.resumeSessionId!, { env, cwd: process.cwd() }).todoState,
        ).toEqual([]);
      } finally {
        await runtime.close();
        await host.close();
      }
    },
  );

  test("keeps the startup subagent profile snapshot", async () => {
    const env = createTempEnv();
    const agentsDirectory = path.join(env.KANA_HOME ?? "", "agents");
    mkdirSync(agentsDirectory, { recursive: true });
    const profilePath = path.join(agentsDirectory, "focused.md");
    writeFileSync(profilePath, subagentProfile("Initial instructions."));
    const host = createKanaConversationHost({ env, session: { type: "none" } });

    const first = host.loadSubagentProfiles();
    const focused = first.profiles.find((profile) => profile.name === "focused");
    if (focused) focused.instructions = "Changed returned snapshot.";
    writeFileSync(profilePath, subagentProfile("Updated on disk."));
    writeFileSync(path.join(agentsDirectory, "later.md"), subagentProfile("Added later."));

    const second = host.loadSubagentProfiles();

    expect(second.profiles.find((profile) => profile.name === "focused")?.instructions).toBe(
      "Initial instructions.",
    );
    expect(second.profiles.map((profile) => profile.name)).not.toContain("later");
    await host.close();
  });

  test("inspects committed child messages together with its current streaming reply", async () => {
    const env = createTempEnv();
    process.env.KANA_HOME = env.KANA_HOME;
    const agentsDirectory = path.join(env.KANA_HOME ?? "", "agents");
    mkdirSync(agentsDirectory, { recursive: true });
    writeFileSync(path.join(agentsDirectory, "focused.md"), subagentProfile("Inspect the parser."));
    const model = new ControlledModel();
    let runSubagent: KanaAgentOptions["runSubagent"];
    let child: Agent | undefined;
    const host = createKanaConversationHost({
      env,
      createAgent: (_config, options = {}) => {
        if (!options.subagentProfile) runSubagent = options.runSubagent;
        const agent = new Agent({
          model: options.subagentProfile
            ? model
            : new MockModel({ provider: "mock", model: "mock" }),
          journal: options.journal,
          onRunCommitted: options.onRunCommitted,
          tools: [
            {
              name: "read",
              description: "Read a file",
              parameters: { type: "object", properties: {} },
              execute: () => ({ content: "Parser contents", result: { path: "src/parser.ts" } }),
            },
          ],
        });
        if (options.subagentProfile) child = agent;
        return agent;
      },
    });
    try {
      const sessionId = host.initialSession?.metadata.id ?? "";
      host.createAgent({ sessionId });
      const client = host.getSubagents(sessionId);
      const profile = host
        .loadSubagentProfiles()
        .profiles.find((entry) => entry.name === "focused");
      if (!client || !profile || !runSubagent) throw new Error("Missing subagent binding.");
      const started = client.start({
        profile,
        task: "Inspect the parser",
        spawnToolCallId: "call-spawn",
        run: runSubagent,
      });
      await waitFor(() => model.requests.length === 1);
      model.requests[0]!.complete(
        [
          { type: "thinking", text: "Reading the parser first" },
          { type: "tool_call", id: "read-parser", name: "read", args: { path: "src/parser.ts" } },
        ],
        "toolUse",
      );
      await waitFor(() => model.requests.length === 2);
      model.requests[1]!.update("Partial parser review");
      await waitFor(
        () =>
          child?.state.streamingMessage?.content.some(
            (content) => content.type === "text" && content.text === "Partial parser review",
          ) === true,
      );

      const inspection = client.inspect(started.id);
      expect(inspection?.status).toBe("running");
      expect(inspection?.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "assistant",
      ]);
      expect(inspection?.messages.at(-1)).toMatchObject({
        content: [{ type: "text", text: "Partial parser review" }],
      });
      expect(inspection?.model).toEqual({ provider: "test", model: "controlled" });

      model.requests[1]!.complete("Final parser review");
      await expect(client.wait(started.id, { waitMs: 100 })).resolves.toMatchObject({
        status: "completed",
        output: "Final parser review",
      });
      expect(client.inspect(started.id)?.messages.at(-1)).toMatchObject({
        content: [{ type: "text", text: "Final parser review" }],
      });
      expect(inspection?.messages.at(-1)).toMatchObject({
        content: [{ type: "text", text: "Partial parser review" }],
      });
    } finally {
      await host.close();
    }
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

    runtime.reconfigure("deepseek-v4-pro");
    await runtime.submit({
      ...messageIdentityForTest("user"),
      role: "user",
      content: "Run the task.",
    });

    expect(seenModels).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(host.config.agent.model.name).toBe("deepseek-v4-pro");
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
        registry: undefined,
        diagnostics: [],
        selectedServerIds: [],
        start: async () => {
          mcpStartCount += 1;
          return { diagnostics: [], selectedServerIds: [] };
        },
        reload: async () => ({ diagnostics: [], selectedServerIds: [] }),
        close: async () => {},
      })) as never,
    });
    const sessionId = host.initialSession?.metadata.id;

    host.createAgent({ sessionId });
    const mcpSnapshot = await host.startMcp();

    expect(seenLaunchModes).toEqual(["clean"]);
    expect(mcpStartCount).toBe(0);
    expect(mcpSnapshot).toEqual({ diagnostics: [], selectedServerIds: [] });
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
          saveArtifact = () => artifactStore.saveText("temporary output", "shell");
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

function subagentProfile(instructions: string): string {
  return ["---", "description: Focused work", "tools: [read]", "---", instructions, ""].join("\n");
}
