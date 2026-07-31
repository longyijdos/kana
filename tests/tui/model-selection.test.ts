import { describe, expect, test } from "bun:test";
import { DEFAULT_KANA_CONFIG, getKanaModelManagement } from "@/kana";
import type { Message } from "../../src/core";
import { KanaTuiApp } from "../../src/tui/app/app";
import { applyTuiModelSelection, type TuiModelSelection } from "../../src/tui/app/model-selection";
import { stripAnsi } from "../../src/tui/render";
import type { Component, Terminal } from "../../src/tui/runtime";

type AgentFactory = ConstructorParameters<typeof KanaTuiApp>[0];
type AgentFactoryOptions = Parameters<AgentFactory>[0];

describe("TUI model selection", () => {
  test("applies a selection only to the active provider fields", () => {
    const config = structuredClone(DEFAULT_KANA_CONFIG);
    const deepSeekBefore = structuredClone(config.model.deepseek);

    applyTuiModelSelection(config, {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "ultra",
    });

    expect(config.provider.active).toBe("openai-codex");
    expect(config.model["openai-codex"]).toMatchObject({
      name: "gpt-5.6-luna",
      reasoningEffort: "ultra",
    });
    expect(config.model.deepseek).toEqual(deepSeekBefore);
  });

  test("renders provider and model choices supplied by the product layer", () => {
    const settings = structuredClone(DEFAULT_KANA_CONFIG);
    const management = getKanaModelManagement(settings);
    const app = new KanaTuiApp(
      () =>
        createAgentStub({
          messages: [],
          provider: "deepseek",
          model: "deepseek-v4-pro",
        }) as never,
      createTerminal(),
      {
        ...createOptions(),
        modelManagement: {
          getSettings: () => ({
            ...management,
            providers: [{ value: "deepseek", label: "Product DeepSeek" }],
            model: {
              ...management.model,
              deepseek: {
                ...management.model.deepseek,
                available: ["product-model"],
              },
            },
          }),
        },
      },
    );
    const internal = app as unknown as AppInternals;

    openModel(internal);
    expect(renderLayout(internal)).toContain("Product DeepSeek");
    press(internal, "\r");
    expect(renderLayout(internal)).toContain("product-model");
  });

  test("switches provider, model, and reasoning while preserving conversation state", () => {
    const messages: Message[] = [{ role: "user", content: "keep this context" }];
    const calls: AgentFactoryOptions[] = [];
    const agents: AgentStub[] = [];
    const logEvents: string[] = [];
    const app = new KanaTuiApp(
      (options) => {
        calls.push(options);
        const selection = options.modelSelection;
        const agent = createAgentStub({
          messages: options.messages ?? [],
          provider: selection?.provider ?? "deepseek",
          model: selection?.model ?? "deepseek-v4-pro",
        });
        agents.push(agent);
        return agent as never;
      },
      createTerminal(),
      {
        ...createOptions(),
        initialSession: {
          id: "session",
          messages,
          timeline: [],
        },
        getLogger: () => createLogger(logEvents),
      },
    );
    const internal = app as unknown as AppInternals;

    openModel(internal);
    chooseCodexLunaHigh(internal);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.messages).toEqual(messages);
    expect(calls[1]?.modelSelection).toEqual({
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
    });
    expect(agents[0]?.abortCount).toBe(1);
    expect(internal.slashCommandOptions.active).toBe(false);
    expect(renderLayout(internal)).toContain("openai-codex/gpt-5.6-luna");
    expect(renderTranscript(internal)).toContain(
      "Switched to openai-codex/gpt-5.6-luna · reasoning high.",
    );
    expect(logEvents).toEqual([
      "tui.model_switch_started",
      "conversation.agent_reconfigured",
      "tui.model_switch_completed",
    ]);
  });

  test("maps DeepSeek reasoning Off to thinking disabled", () => {
    const selections: TuiModelSelection[] = [];
    const app = new KanaTuiApp(
      (options) => {
        if (options.modelSelection) {
          selections.push(options.modelSelection);
        }
        return createAgentStub({
          messages: options.messages ?? [],
          provider: options.modelSelection?.provider ?? "deepseek",
          model: options.modelSelection?.model ?? "deepseek-v4-pro",
        }) as never;
      },
      createTerminal(),
      createOptions(),
    );
    const internal = app as unknown as AppInternals;

    openModel(internal);
    press(internal, "\r");
    press(internal, "\r");
    press(internal, "\x1b[A");
    press(internal, "\r");

    expect(selections).toEqual([
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        thinking: false,
        reasoningEffort: "high",
      },
    ]);
  });

  test("keeps the current Agent when replacement fails", () => {
    const firstAgent = createAgentStub({
      messages: [],
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
    const logEvents: string[] = [];
    let createCount = 0;
    const app = new KanaTuiApp(
      (options) => {
        createCount += 1;
        if (options.modelSelection) {
          throw new Error("provider unavailable");
        }
        return firstAgent as never;
      },
      createTerminal(),
      {
        ...createOptions(),
        getLogger: () => createLogger(logEvents),
      },
    );
    const internal = app as unknown as AppInternals;

    openModel(internal);
    chooseCodexLunaHigh(internal);

    expect(createCount).toBe(2);
    expect(firstAgent.abortCount).toBe(0);
    expect(renderLayout(internal)).toContain("deepseek/deepseek-v4-pro");
    expect(renderTranscript(internal)).toContain("provider unavailable");
    expect(logEvents).toEqual(["tui.model_switch_started", "tui.model_switch_failed"]);
  });

  test("moves back through nested model prompts with Escape", () => {
    const app = new KanaTuiApp(
      () =>
        createAgentStub({
          messages: [],
          provider: "deepseek",
          model: "deepseek-v4-pro",
        }) as never,
      createTerminal(),
      createOptions(),
    );
    const internal = app as unknown as AppInternals;

    openModel(internal);
    press(internal, "\r");
    press(internal, "\r");
    expect(renderLayout(internal)).toContain("Reasoning effort");

    press(internal, "\x1b");
    expect(renderLayout(internal)).toContain("Model");
    press(internal, "\x1b");
    expect(renderLayout(internal)).toContain("Provider");
    press(internal, "\x1b");

    expect(internal.slashCommandOptions.active).toBe(false);
    expect(renderLayout(internal)).toContain("deepseek/deepseek-v4-pro");
  });
});

type AgentStub = {
  state: {
    messages: Message[];
    model: {
      metadata: {
        provider: string;
        model: string;
        cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
        contextWindow: number;
        maxOutputTokens: number;
      };
    };
  };
  abortCount: number;
  abort(): void;
  waitForIdle(): Promise<void>;
};

type AppInternals = {
  handleCommand(command: { name: "model"; arguments: string; raw: string }): void;
  slashCommandOptions: { active: boolean };
  transcript: { render(width: number): string[] };
  layout: { render(width: number, availableHeight?: number): string[] };
  tui: { getFocus(): Component | undefined };
};

function createAgentStub(options: {
  messages: Message[];
  provider: string;
  model: string;
}): AgentStub {
  return {
    state: {
      messages: options.messages,
      model: {
        metadata: {
          provider: options.provider,
          model: options.model,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 372_000,
          maxOutputTokens: 128_000,
        },
      },
    },
    abortCount: 0,
    abort() {
      this.abortCount += 1;
    },
    async waitForIdle() {},
  };
}

function createOptions() {
  const settings = structuredClone(DEFAULT_KANA_CONFIG);
  return {
    getResumeSessionId: () => undefined,
    createNewSession: () => ({ id: "new" }),
    forkSession: () => ({ id: "fork" }),
    listSessions: () => [],
    loadSession: () => ({ id: "session", messages: [], timeline: [] }),
    deleteSession: () => false,
    loadSkills: () => ({ skills: [], globalEnabledSkillNames: [], diagnostics: [] }),
    saveEnabledGlobalSkills: () => {},
    toolApproval: { config: {}, approvals: {} } as never,
    notification: {} as never,
    compactMemory: async () => [],
    loadMemory: () => "",
    loadUsage: () => ({
      scope: "session" as const,
      runCount: 0,
      mainRunCount: 0,
      memoryRunCount: 0,
      costCny: 0,
      outcomes: {
        stop: 0,
        length: 0,
        aborted: 0,
        error: 0,
        turn_limit: 0,
        updated: 0,
        unchanged: 0,
      },
      agents: {
        main: { runCount: 0, costCny: 0 },
        memoryAutomatic: { runCount: 0, costCny: 0 },
        memoryManual: { runCount: 0, costCny: 0 },
      },
      models: [],
    }),
    modelManagement: {
      getSettings: () => getKanaModelManagement(settings),
    },
  };
}

function createTerminal(): Terminal {
  return {
    columns: 80,
    rows: 24,
    start: () => {},
    stop: () => {},
    write: () => {},
    notify: () => {},
  };
}

function createLogger(events: string[]) {
  return {
    debug: () => {},
    info: (event: string) => events.push(event),
    warn: () => {},
    error: (event: string) => events.push(event),
  };
}

function openModel(internal: AppInternals): void {
  internal.handleCommand({ name: "model", arguments: "", raw: "/model" });
}

function chooseCodexLunaHigh(internal: AppInternals): void {
  press(internal, "\x1b[B");
  press(internal, "\r");
  press(internal, "\x1b[B");
  press(internal, "\x1b[B");
  press(internal, "\r");
  press(internal, "\x1b[B");
  press(internal, "\r");
}

function press(internal: AppInternals, input: string): void {
  internal.tui.getFocus()?.handleInput?.(input);
}

function renderLayout(internal: AppInternals): string {
  return stripAnsi(internal.layout.render(80, 24).join("\n"));
}

function renderTranscript(internal: AppInternals): string {
  return stripAnsi(internal.transcript.render(80).join("\n"));
}
