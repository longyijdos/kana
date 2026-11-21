import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "../../../src/agent";
import {
  appendKanaMemory,
  ConversationRuntime,
  createKanaConversationHost,
  createKanaSession,
  createKanaSessionJournal,
  getKanaConfigPaths,
  type KanaModelProvider,
  KanaSessionInUseError,
  type KanaTodoItem,
  type MemoryConsolidationActivity,
  type MemoryConsolidationEvent,
} from "../../../src/kana";
import { loadKanaUsageSummary } from "../../../src/kana/accounting";
import type { KanaAgentOptions } from "../../../src/kana/agent";
import { createKanaToolResultArtifactPolicy } from "../../../src/kana/artifacts";
import { getKanaSubagentArtifactParentDirectory } from "../../../src/kana/artifacts/store";
import { createKanaAgentModelRuntime } from "../../../src/kana/model";
import { getKanaSubagentDirectory } from "../../../src/kana/subagents";
import { createRememberTool, createTodoWriteTool } from "../../../src/kana/tools";
import { MockModel } from "../../../src/providers/mock";
import { deferred, waitFor } from "../../helpers/async-control";
import { ControlledModel } from "../../helpers/controlled-model";
import { messageIdentityForTest } from "../../helpers/messages";
import { readOwnedSession } from "../../helpers/session";

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
    expect(readOwnedSession(sessionId ?? "", env).messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);

    await runtime.close();
    await host.close();
  });

  test("queries committed timeline during runs and across session transitions", async () => {
    const env = createTempEnv();
    const model = new ControlledModel();
    const host = createKanaConversationHost({
      env,
      createAgent: (_config, options = {}) =>
        new Agent({
          model,
          messages: options.messages,
          journal: options.journal,
          onRunCommitted: options.onRunCommitted,
        }),
    });
    const runtime = createRuntime(host);
    const originalId = runtime.sessionId!;
    const submit = (content: string) =>
      runtime.submit({ ...messageIdentityForTest("user"), role: "user", content });
    const committedTimeline = (id: string) => host.runtimeOptions.getSessionTimeline(id);
    try {
      expect(runtime.session!.timeline).toEqual([]);
      expect(() => host.runtimeOptions.getSessionTimeline("missing")).toThrow(
        "has no session missing",
      );
      const run = submit("First run.");
      await waitFor(() => model.requests.length === 1);
      const committed = committedTimeline(originalId);
      expect(committed.map((entry) => entry.type)).toEqual(["turn_start", "message"]);
      expect(runtime.session!.timeline).toEqual(committed);
      model.requests[0]!.update("Partial reply");
      await waitFor(() => runtime.state.streamingMessage !== undefined);
      expect(runtime.session!.timeline).toEqual(committed);

      model.requests[0]!.complete("First reply.");
      await run;
      const originalTimeline = committedTimeline(originalId);
      expect(originalTimeline.map((entry) => entry.type)).toEqual([
        "turn_start",
        "message",
        "message",
        "turn_end",
      ]);
      expect(runtime.session!.timeline).toEqual(originalTimeline);
      runtime.reconfigure();
      expect(runtime.session!.timeline).toEqual(originalTimeline);

      const fresh = await runtime.startNewSession();
      expect(fresh.id).not.toBe(originalId);
      expect(fresh.timeline).toEqual([]);
      expect((await runtime.resumeSession(originalId)).timeline.map((entry) => entry.id)).toEqual(
        originalTimeline.map((entry) => entry.id),
      );
      const resumedRun = submit("Second run.");
      await waitFor(() => model.requests.length === 2);
      expect(runtime.session!.timeline).toEqual(committedTimeline(originalId));
      expect(runtime.session!.timeline.length).toBeGreaterThan(originalTimeline.length);
      model.requests[1]!.complete("Second reply.");
      await resumedRun;
      const resumedTimeline = committedTimeline(originalId);
      expect(runtime.session!.timeline).toEqual(resumedTimeline);

      const fork = await runtime.forkSession("Fork history.");
      expect(fork.id).not.toBe(originalId);
      expect(fork.timeline).toEqual([]);
      const forkRun = submit("Fork run.");
      await waitFor(() => model.requests.length === 3);
      expect(runtime.session!.timeline).toEqual(committedTimeline(fork.id));
      model.requests[2]!.complete("Fork reply.");
      await forkRun;
      const forkTimeline = committedTimeline(fork.id);
      expect(runtime.session!.timeline).toEqual(forkTimeline);
      expect(
        forkTimeline.some((entry) => resumedTimeline.some((original) => original.id === entry.id)),
      ).toBe(false);
      expect((await runtime.resumeSession(originalId)).timeline.map((entry) => entry.id)).toEqual(
        resumedTimeline.map((entry) => entry.id),
      );
      expect((await runtime.resumeSession(fork.id)).timeline.map((entry) => entry.id)).toEqual(
        forkTimeline.map((entry) => entry.id),
      );
    } finally {
      await runtime.close();
      await host.close();
    }
  });

  test("switches between startup-loaded Custom providers and restores the choice on restart", async () => {
    const env = createTempEnv();
    const paths = getKanaConfigPaths(env);
    const providerFile = (name: string) => path.join(paths.providersDirectory, `${name}.toml`);
    const writeProvider = (name: string, contextWindow: number, baseUrl: string) =>
      writeFileSync(
        providerFile(name),
        `base_url = "${baseUrl}"\n[[models]]\nname = "shared-model"\ncontext_window = ${contextWindow}\nmax_output_tokens = 4096\n`,
      );
    mkdirSync(paths.providersDirectory);
    writeProvider("custom", 32768, "http://127.0.0.1:8080/v1");
    writeProvider("gateway", 65536, "https://gateway.example.com/v1");
    writeFileSync(providerFile("broken"), 'base_url = "https://broken.example.com/v1"\n');
    writeFileSync(paths.customProviderExamplePath, "ignored example");
    writeFileSync(
      paths.configPath,
      '[agent.model]\nprovider = "custom:custom"\nname = "shared-model"\n',
    );

    const host = createKanaConversationHost<KanaModelProvider>({
      env,
      session: { type: "none" },
      applyAgentConfiguration: (draft, provider) => {
        draft.agent.model.provider = provider;
      },
    });
    const runtime = createRuntime(host);
    try {
      writeProvider("gateway", 131072, "https://gateway.example.com/v1");
      writeProvider("later", 32768, "https://later.example.com/v1");
      const management = host.getModelManagement();
      expect(management.providers.map(({ value }) => value)).toEqual([
        "deepseek",
        "openai-codex",
        "custom:broken",
        "custom:custom",
        "custom:gateway",
      ]);
      expect(management.providers).toContainEqual({
        value: "custom:gateway",
        label: "Custom · gateway",
      });
      expect(management.providers).toContainEqual({
        value: "custom:custom",
        label: "Custom · custom",
      });
      expect(management.model["custom:broken"]?.error).toContain(providerFile("broken"));
      expect(runtime.state.model.metadata).toMatchObject({
        provider: "custom:custom",
        contextWindow: 32768,
      });
      expect(() => runtime.reconfigure("custom:broken")).toThrow(providerFile("broken"));
      expect(host.config.agent.model.provider).toBe("custom:custom");

      runtime.reconfigure("custom:gateway");
      expect(runtime.state.model.metadata).toMatchObject({
        provider: "custom:gateway",
        model: "shared-model",
        contextWindow: 65536,
      });
      expect(host.getModelManagement().activeProvider).toBe("custom:gateway");
    } finally {
      await runtime.close();
      await host.close();
    }

    const restarted = createKanaConversationHost({ env, session: { type: "none" } });
    try {
      expect(restarted.createAgent({}).state.model.metadata).toMatchObject({
        provider: "custom:gateway",
        model: "shared-model",
        contextWindow: 131072,
      });
      expect(restarted.getModelManagement().providers).toContainEqual({
        value: "custom:later",
        label: "Custom · later",
      });
    } finally {
      await restarted.close();
    }
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

  test("starts memory recovery only on first session activation and accounts to it after a switch", async () => {
    const env = createTempEnv();
    process.env.KANA_HOME = env.KANA_HOME;
    appendKanaMemory({ env, scope: "project", content: "From the previous process." });
    const finish = deferred();
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        requests++;
        await finish.promise;
        return new Response(
          [
            'data: {"choices":[{"index":0,"delta":{"content":"Partial"}}]}',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}',
            'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const { providersDirectory } = getKanaConfigPaths(env);
    mkdirSync(providersDirectory, { recursive: true });
    writeFileSync(
      path.join(providersDirectory, "memory-test.toml"),
      [
        `base_url = "http://127.0.0.1:${server.port}/v1"`,
        "max_retries = 0",
        "[[models]]",
        'name = "test"',
        "context_window = 32768",
        "max_output_tokens = 4096",
      ].join("\n"),
    );
    const host = createKanaConversationHost({
      env,
      session: { type: "none" },
      configOverrides: [
        'memory.agent.model.provider="custom:memory-test"',
        'memory.agent.model.name="test"',
      ],
      createAgent: () => new Agent({ model: new MockModel({ provider: "mock", model: "mock" }) }),
    });
    try {
      const first = host.runtimeOptions.createNewSession();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(host.getMemoryActivity()).toEqual([]);
      expect(requests).toBe(0);

      host.createAgent({ sessionId: first.id });
      await waitFor(() => requests === 1);
      const second = host.runtimeOptions.createNewSession();
      host.createAgent({ sessionId: second.id });
      expect(host.getMemoryActivity()).toEqual([{ scope: "project", status: "organizing" }]);
      finish.resolve();
      await waitFor(() => host.getMemoryActivity().length === 0);
      expect(requests).toBe(1);
      expect(
        loadKanaUsageSummary({ scope: "session", sessionId: first.id, env }).agents.memoryAutomatic,
      ).toMatchObject({ runCount: 1, usage: { totalTokens: 7 } });
      expect(host.loadUsage("session").memoryRunCount).toBe(0);
    } finally {
      finish.resolve();
      await host.close();
      server.stop(true);
    }
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
          'memory.agent.model.provider="custom:custom"',
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
        ).toContain('Custom provider configuration for "custom:custom" was not found');
        const saved = readOwnedSession(host.resumeSessionId!, env);
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
        expect(runtime.session!.timeline).toEqual(
          host.runtimeOptions.getSessionTimeline(runtime.sessionId!),
        );
        expect(
          runtime.session!.timeline.filter((entry) => entry.type === "todo_state"),
        ).toHaveLength(2);
        model.requests[1]!.complete("Tracked.");
        await run;
        const saved = readOwnedSession(host.resumeSessionId!, env);
        expect(saved.todoState).toEqual(items);
        expect(runtime.session!.timeline.map((entry) => entry.id)).toEqual(
          saved.timeline.map((entry) => entry.id),
        );
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
        expect(readOwnedSession(host.resumeSessionId!, env).todoState).toEqual([]);
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

    host.loadSubagentProfiles();
    writeFileSync(profilePath, subagentProfile("Updated on disk."));
    writeFileSync(path.join(agentsDirectory, "later.md"), subagentProfile("Added later."));

    const second = host.loadSubagentProfiles();

    expect(second.profiles.find((profile) => profile.name === "focused")?.instructions).toBe(
      "Initial instructions.",
    );
    expect(second.profiles.map((profile) => profile.name)).not.toContain("later");
    await host.close();
  });

  test("resolves child token budgets against the inherited or explicit model", async () => {
    const env = { ...createTempEnv(), DEEPSEEK_API_KEY: "test" };
    const directory = getKanaConfigPaths(env).agentsDirectory;
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      getKanaConfigPaths(env).configPath,
      "[agent.model]\nmax_output_tokens = 4096\ncontext_limit = 32768\n",
    );
    const cards = {
      inherited: [],
      override: ["model: inherit", "max_output_tokens: 2048"],
      explicit: ["model: deepseek/deepseek-v4-pro"],
      mixed: ["model: deepseek/deepseek-v4-pro", "context_limit: 65536"],
    };
    for (const [name, fields] of Object.entries(cards)) {
      writeFileSync(
        path.join(directory, `${name}.md`),
        ["---", "description: Focused work", ...fields, "---", "Review the parser."].join("\n"),
      );
    }
    let runSubagent: KanaAgentOptions["runSubagent"];
    const runtimes = new Map<string, ReturnType<typeof createKanaAgentModelRuntime>>();
    const host = createKanaConversationHost({
      env,
      createAgent: (config, options = {}) => {
        if (options.subagentProfile) {
          runtimes.set(
            options.subagentProfile.name,
            createKanaAgentModelRuntime(config.agent, config.provider, { env }),
          );
        } else {
          runSubagent = options.runSubagent;
        }
        return new Agent({ model: new MockModel({ provider: "mock", model: "mock" }) });
      },
    });
    try {
      const sessionId = host.initialSession!.metadata.id;
      host.createAgent({ sessionId });
      const client = host.runtimeOptions.getSubagents(sessionId)!;
      for (const profile of host.loadSubagentProfiles().profiles) {
        const { id } = client.start({
          profile,
          task: "Inspect",
          spawnToolCallId: "spawn",
          run: runSubagent!,
        });
        await expect(client.wait(id, { waitMs: 100 })).resolves.toMatchObject({
          status: "completed",
        });
      }
      expect(runtimes.get("inherited")).toMatchObject({
        maxOutputTokens: 4096,
        contextLimit: 32768,
      });
      expect(runtimes.get("override")).toMatchObject({
        maxOutputTokens: 2048,
        contextLimit: 32768,
      });
      const explicit = runtimes.get("explicit")!;
      expect(explicit.model.metadata.model).toBe("deepseek-v4-pro");
      expect(explicit).toMatchObject({
        maxOutputTokens: explicit.model.metadata.maxOutputTokens,
        contextLimit: explicit.model.metadata.contextWindow,
      });
      expect(runtimes.get("mixed")).toMatchObject({
        maxOutputTokens: explicit.model.metadata.maxOutputTokens,
        contextLimit: 65536,
      });
    } finally {
      await host.close();
    }
  });

  test.each([true, false])(
    "inspects child progress and inherits tool_result_artifacts=%s",
    async (artifactsEnabled) => {
      const env = createTempEnv();
      process.env.KANA_HOME = env.KANA_HOME;
      const agentsDirectory = path.join(env.KANA_HOME ?? "", "agents");
      mkdirSync(agentsDirectory, { recursive: true });
      writeFileSync(
        path.join(agentsDirectory, "focused.md"),
        subagentProfile("Inspect the parser."),
      );
      writeFileSync(
        path.join(env.KANA_HOME ?? "", "config.toml"),
        `[agent]\ntool_result_artifacts = ${artifactsEnabled}\n`,
      );
      const content = "Parser contents\n".repeat(3_000);
      const model = new ControlledModel();
      let runSubagent: KanaAgentOptions["runSubagent"];
      let child: Agent | undefined;
      const host = createKanaConversationHost({
        env,
        createAgent: (config, options = {}) => {
          if (!options.subagentProfile) runSubagent = options.runSubagent;
          expect(config.agent.toolResultArtifacts).toBe(artifactsEnabled);
          const agent = new Agent({
            model: options.subagentProfile
              ? model
              : new MockModel({ provider: "mock", model: "mock" }),
            journal: options.journal,
            onRunCommitted: options.onRunCommitted,
            context: { contextLimit: 128_000, maxOutputTokens: 16_000 },
            toolResultPolicy: createKanaToolResultArtifactPolicy({
              store: config.agent.toolResultArtifacts ? options.artifactStore : undefined,
            }),
            tools: [
              {
                name: "shell",
                description: "Inspect the parser",
                parameters: { type: "object", properties: {} },
                execute: () => ({ content, result: { path: "src/parser.ts" } }),
              },
            ],
          });
          if (options.subagentProfile) child = agent;
          return agent;
        },
      });
      try {
        const sessionId = host.initialSession?.metadata.id ?? "";
        await host.createAgent({ sessionId }).prompt("Delegate the parser review");
        const client = host.runtimeOptions.getSubagents(sessionId);
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
            { type: "tool_call", id: "read-parser", name: "shell", args: {} },
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
        const toolMessage = inspection?.messages.find((message) => message.role === "tool");
        const artifact = toolMessage?.artifact;
        expect(artifact !== undefined).toBe(artifactsEnabled);
        if (artifact) {
          expect(path.dirname(artifact.locator)).toBe(
            path.join(
              getKanaSubagentArtifactParentDirectory(sessionId, process.cwd(), env),
              started.id,
            ),
          );
          expect(readFileSync(artifact.locator, "utf8")).toBe(content);
          expect(toolMessage?.content).toContain(artifact.locator);
        } else {
          expect(toolMessage?.content).toContain("[Tool output truncated for model context]");
        }

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
        expect(client.continue(started.id, "Explain the first finding")).toMatchObject({
          id: started.id,
          runNumber: 2,
          status: "running",
        });
        await waitFor(() => model.requests.length === 3);
        expect(model.requests[2]?.context.messages).toContainEqual(
          expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "Final parser review" }],
          }),
        );
        expect(model.requests[2]?.context.messages.at(-1)).toMatchObject({
          role: "user",
          content: "Explain the first finding",
        });
        model.requests[2]!.complete("Here is the explanation.");
        await expect(client.wait(started.id, { waitMs: 100 })).resolves.toMatchObject({
          runNumber: 2,
          status: "completed",
          output: "Here is the explanation.",
        });
        expect(client.inspect(started.id)?.messages).toHaveLength(6);
        expect(
          loadKanaUsageSummary({ scope: "session", sessionId, env }).agents.subagent.runCount,
        ).toBe(2);

        const journalDirectory = getKanaSubagentDirectory(process.cwd(), sessionId, env);
        const files = readdirSync(journalDirectory);
        expect(files).toHaveLength(1);
        const journalPath = path.join(journalDirectory, files[0]!);
        const journal = readFileSync(journalPath, "utf8");
        expect(journal).toContain("Final parser review");
        expect(journal).toContain("Here is the explanation.");
        if (artifact) expect(journal).toContain(JSON.stringify(artifact.locator));
        await expect(host.runtimeOptions.deleteSession(sessionId)).resolves.toBe(true);
        expect(existsSync(journalPath)).toBe(false);
        if (artifact) expect(existsSync(artifact.locator)).toBe(false);
      } finally {
        await host.close();
      }
    },
  );

  test.each(["provider error", "tool", "tui"] as const)(
    "continues an interrupted child after %s without replaying tools",
    async (interruption) => {
      const env = createTempEnv();
      const directory = getKanaConfigPaths(env).agentsDirectory;
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "focused.md"), subagentProfile("Inspect the parser."));
      const model = new ControlledModel();
      let runSubagent: KanaAgentOptions["runSubagent"];
      let childCount = 0;
      let toolCalls = 0;
      const host = createKanaConversationHost({
        env,
        createAgent: (_config, options = {}) => {
          if (!options.subagentProfile) {
            runSubagent = options.runSubagent;
            return new Agent({ model: new MockModel({ provider: "mock", model: "mock" }) });
          }
          childCount += 1;
          return new Agent({
            model,
            journal: options.journal,
            onRunCommitted: options.onRunCommitted,
            tools: [
              {
                name: "mark_work",
                description: "Record the finished work",
                parameters: { type: "object", properties: {} },
                execute: () => {
                  toolCalls += 1;
                  return { content: "First step committed" };
                },
              },
            ],
          });
        },
      });
      try {
        const sessionId = host.initialSession!.metadata.id;
        host.createAgent({ sessionId });
        const client = host.runtimeOptions.getSubagents(sessionId)!;
        const [profile] = host.loadSubagentProfiles().profiles;
        const { id } = client.start({
          profile: profile!,
          task: "Start work",
          spawnToolCallId: "spawn",
          run: runSubagent!,
        });
        await waitFor(() => model.requests.length === 1);
        model.requests[0]!.complete(
          [{ type: "tool_call", id: "mark-first", name: "mark_work", args: {} }],
          "toolUse",
        );
        await waitFor(() => model.requests.length === 2);
        if (interruption === "provider error") {
          model.requests[1]!.fail();
        } else {
          await client.cancel(id, { source: interruption });
        }
        await expect(client.wait(id, { waitMs: 100 })).resolves.toMatchObject({
          runNumber: 1,
          status: interruption === "provider error" ? "errored" : "cancelled",
        });
        expect(model.requests).toHaveLength(2);

        expect(client.continue(id, "Continue after the committed step")).toMatchObject({
          id,
          runNumber: 2,
        });
        await waitFor(() => model.requests.length === 3);
        expect(model.requests[2]?.context.messages).toContainEqual(
          expect.objectContaining({
            role: "tool",
            toolCallId: "mark-first",
            result: { content: "First step committed" },
          }),
        );
        model.requests[2]!.complete("Resumed.");
        await expect(client.wait(id, { waitMs: 100 })).resolves.toMatchObject({
          status: "completed",
          runNumber: 2,
          output: "Resumed.",
        });
        expect(childCount).toBe(1);
        expect(toolCalls).toBe(1);
      } finally {
        await host.close();
      }
    },
  );

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
    expect(runtime.session!.timeline).toEqual([]);
    expect(host.runtimeOptions.getSessionTimeline(runtime.sessionId!)).toEqual([]);
    expect(host.runtimeOptions.listSessions()).toEqual([]);
    expect(() => host.loadSession("saved-session")).toThrow(
      "Saved sessions are unavailable in clean mode.",
    );
    await expect(host.runtimeOptions.deleteSession("saved-session")).rejects.toThrow(
      "Saved sessions are unavailable in clean mode.",
    );
    expect(() => host.runtimeOptions.forkSession([], undefined, "Fork the task.")).toThrow(
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
    const seenOptions: Array<{ mcp: boolean; memory: boolean | undefined }> = [];
    const host = createKanaConversationHost({
      env,
      launchMode: "clean",
      createAgent: (_config, options = {}) => {
        seenOptions.push({ mcp: options.resolveMcp !== undefined, memory: options.memoryEnabled });
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

    expect(seenOptions).toEqual([{ mcp: false, memory: false }]);
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

    const fork = host.runtimeOptions.forkSession([], undefined, "Continue independently.");
    expect(fork.todoState).toEqual(todoState);

    const forkAgent = host.createAgent({ sessionId: fork.id });
    expect(resolveTodoState?.()).toEqual(todoState);
    await forkAgent.prompt("Continue the fork.");

    const loadedFork = readOwnedSession(fork.id, env);
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
    const jobs = host.runtimeOptions.getBackgroundJobs(deletedSession.id);
    let cancelled = false;
    jobs?.start({
      kind: "test",
      label: "pending cleanup",
      run: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              resolve({ status: "cancelled", exitCode: null });
            },
            { once: true },
          );
        }),
    });

    expect(await host.runtimeOptions.deleteSession(deletedSession.id)).toBe(true);
    expect(cancelled).toBe(true);
    expect(jobs?.list()).toEqual([]);
    expect(
      host.runtimeOptions.listSessions().some((session) => session.id === deletedSession.id),
    ).toBe(false);

    await host.close();
  });

  test("rejects reopening a session while this host still owns it", async () => {
    const env = createTempEnv();
    const session = createKanaSession({ cwd: process.cwd(), env, id: "same-id" });
    createKanaSessionJournal(session).appendSnapshot([
      {
        ...messageIdentityForTest("user"),
        role: "user",
        content: "Resume this exact session.",
      },
    ]);
    const model = new ControlledModel();
    const host = createKanaConversationHost({
      env,
      session: { type: "resume", sessionId: session.id },
      createAgent: (_config, options = {}) =>
        new Agent({
          model,
          messages: options.messages,
          beforeToolExecution: options.beforeToolExecution,
          journal: options.journal,
        }),
    });
    const runtime = createRuntime(host);
    const run = runtime.submit({
      ...messageIdentityForTest("user"),
      role: "user",
      content: "Keep this turn open.",
    });
    await waitFor(() => model.requests.length === 1);
    const contentDuringTurn = readFileSync(session.path, "utf8");

    expect(() => host.loadSession(session.id)).toThrow(KanaSessionInUseError);
    expect(readFileSync(session.path, "utf8")).toBe(contentDuringTurn);
    await expect(runtime.resumeSession(session.id)).rejects.toThrow("run is active");

    model.requests[0]!.complete("Done.");
    await run;
    await expect(runtime.resumeSession(session.id)).rejects.toThrow("already the current session");

    await runtime.close();
    await host.close();
  });

  test("keeps a resumed session owned until the hosting conversation closes", async () => {
    const env = createTempEnv();
    const session = createKanaSession({ cwd: process.cwd(), env, id: "owned" });
    createKanaSessionJournal(session).appendSnapshot([
      { ...messageIdentityForTest("user"), role: "user", content: "Own this session." },
    ]);
    const resume = { type: "resume", sessionId: session.id } as const;
    const owner = createKanaConversationHost({ env, session: resume });
    const competitor = createKanaConversationHost({ env, session: { type: "none" } });

    expect(() => competitor.loadSession(session.id)).toThrow(KanaSessionInUseError);
    await expect(competitor.runtimeOptions.deleteSession(session.id)).rejects.toThrow(
      KanaSessionInUseError,
    );
    await owner.close();
    expect(competitor.loadSession(session.id).messages).toHaveLength(1);

    await competitor.close();
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
    createNewSession: () => host.runtimeOptions.createNewSession(),
    getSessionTimeline: (sessionId) => host.runtimeOptions.getSessionTimeline(sessionId),
    forkSession: (messages, contextCheckpoint, prompt) =>
      host.runtimeOptions.forkSession(messages, contextCheckpoint, prompt),
    loadSession: (sessionId) => {
      const session = host.loadSession(sessionId);
      return {
        id: session.metadata.id,
        messages: session.messages,
        timeline: session.timeline,
        contextCheckpoint: session.contextCheckpoint,
      };
    },
    listSessions: () => host.runtimeOptions.listSessions(),
    deleteSession: (sessionId) => host.runtimeOptions.deleteSession(sessionId),
    disposeSession: (sessionId, source, foregroundSettled) =>
      host.runtimeOptions.disposeSession(sessionId, source, foregroundSettled),
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
