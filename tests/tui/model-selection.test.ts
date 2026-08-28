import { describe, expect, test } from "bun:test";
import { DEFAULT_KANA_CONFIG, getKanaModelManagement } from "@/kana";
import type { Message } from "../../src/core";
import { KanaTuiApp } from "../../src/tui/app/app";
import { applyTuiModelSelection, type TuiModelSelection } from "../../src/tui/app/model-selection";
import { stripAnsi } from "../../src/tui/render";
import type { Component } from "../../src/tui/runtime";
import { withAgentInboxForTest } from "../helpers/agent-inbox";
import { messageIdentityForTest } from "../helpers/messages";
import { createTerminalStub as createTerminal, createTuiAppOptions } from "./app-fixture";

type AgentFactory = ConstructorParameters<typeof KanaTuiApp>[0];
type AgentFactoryOptions = Parameters<AgentFactory>[0];

describe("TUI model selection", () => {
  test("applies a selection only to the active provider fields", () => {
    const config = structuredClone(DEFAULT_KANA_CONFIG);
    config.agent.model.maxOutputTokens = 64_000;
    config.agent.model.contextLimit = 200_000;
    const memoryAgentBefore = structuredClone(config.memory.agent);

    applyTuiModelSelection(config, {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
    });

    expect(config.agent.model).toEqual({
      provider: "openai-codex",
      name: "gpt-5.6-luna",
      reasoningEffort: "max",
      maxOutputTokens: 64_000,
      contextLimit: 200_000,
    });
    expect(config.memory.agent).toEqual(memoryAgentBefore);
  });

  test("offers provider-specific reasoning efforts", () => {
    const management = getKanaModelManagement(structuredClone(DEFAULT_KANA_CONFIG));

    expect(management.model.deepseek.available[0]?.reasoning?.efforts).toEqual([
      "none",
      "low",
      "high",
      "max",
    ]);
    expect(management.model["openai-codex"].available[0]?.reasoning?.efforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
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
        models: {
          getSettings: () => ({
            ...management,
            providers: [{ value: "deepseek", label: "Product DeepSeek" }],
            model: {
              ...management.model,
              deepseek: {
                ...management.model.deepseek,
                available: [{ name: "product-model", supportsImageInput: false }],
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
    const messages: Message[] = [
      { ...messageIdentityForTest("user"), role: "user", content: "keep this context" },
    ];
    const calls: AgentFactoryOptions[] = [];
    const agents: AgentStub[] = [];
    const logEvents: string[] = [];
    const appOptions = createOptions();
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
        ...appOptions,
        conversation: {
          ...appOptions.conversation,
          initialSession: {
            id: "session",
            messages,
            timeline: [],
          },
        },
        diagnostics: { getLogger: () => createLogger(logEvents) },
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
    expect(renderLayout(internal)).toContain("gpt-5.6-luna · high | Idle");
    expect(renderTranscript(internal)).toContain(
      "Switched to openai-codex/gpt-5.6-luna · reasoning high.",
    );
    expect(logEvents).toEqual([
      "tui.model_switch_started",
      "conversation.agent_reconfigured",
      "tui.model_switch_completed",
    ]);
  });

  test("maps DeepSeek reasoning Off to the none effort", () => {
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
    press(internal, "\x1b[A");
    press(internal, "\r");

    expect(selections).toEqual([
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        reasoningEffort: "none",
      },
    ]);
    expect(renderLayout(internal)).toContain("deepseek-v4-pro · off | Idle");
  });

  test("offers configured reasoning efforts for a Custom model", () => {
    const selections: TuiModelSelection[] = [];
    const management = getKanaModelManagement(structuredClone(DEFAULT_KANA_CONFIG));
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
      {
        ...createOptions(),
        models: {
          getSettings: () => ({
            ...management,
            providers: [{ value: "custom", label: "Custom" }],
            model: {
              ...management.model,
              custom: {
                available: [
                  {
                    name: "reasoning-model",
                    reasoning: { efforts: ["none", "high"], defaultEffort: "none" },
                    supportsImageInput: false,
                  },
                ],
                name: "reasoning-model",
                reasoningEffort: "none",
                imageInputEnabled: false,
              },
            },
          }),
        },
      },
    );
    const internal = app as unknown as AppInternals;

    openModel(internal);
    press(internal, "\r");
    press(internal, "\r");
    expect(renderLayout(internal)).toContain("Reasoning effort");
    press(internal, "\x1b[B");
    press(internal, "\r");

    expect(selections).toEqual([
      { provider: "custom", model: "reasoning-model", reasoningEffort: "high" },
    ]);
    expect(renderLayout(internal)).toContain("reasoning-model · high | Idle");
  });

  test("skips reasoning selection for a Custom model without reasoning metadata", () => {
    const selections: TuiModelSelection[] = [];
    const management = getKanaModelManagement(structuredClone(DEFAULT_KANA_CONFIG));
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
      {
        ...createOptions(),
        models: {
          getSettings: () => ({
            ...management,
            providers: [{ value: "custom", label: "Custom" }],
            model: {
              ...management.model,
              custom: {
                available: [{ name: "local-model", supportsImageInput: false }],
                name: "local-model",
                imageInputEnabled: false,
              },
            },
          }),
        },
      },
    );
    const internal = app as unknown as AppInternals;

    openModel(internal);
    press(internal, "\r");
    press(internal, "\r");

    expect(selections).toEqual([{ provider: "custom", model: "local-model" }]);
    expect(internal.slashCommandOptions.active).toBe(false);
    expect(renderLayout(internal)).toContain("local-model | Idle");
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
        diagnostics: { getLogger: () => createLogger(logEvents) },
      },
    );
    const internal = app as unknown as AppInternals;

    openModel(internal);
    chooseCodexLunaHigh(internal);

    expect(createCount).toBe(2);
    expect(firstAgent.abortCount).toBe(0);
    expect(renderLayout(internal)).toContain("deepseek-v4-pro · high | Error");
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
    expect(renderLayout(internal)).toContain("deepseek-v4-pro · high | Idle");
  });
});

type AgentStub = {
  state: {
    messages: Message[];
    model: {
      metadata: {
        provider: string;
        model: string;
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
  return withAgentInboxForTest({
    state: {
      messages: options.messages,
      model: {
        metadata: {
          provider: options.provider,
          model: options.model,
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
  }) as AgentStub;
}

function createOptions() {
  const settings = structuredClone(DEFAULT_KANA_CONFIG);
  const options = createTuiAppOptions();
  return {
    ...options,
    conversation: {
      ...options.conversation,
      goalMaxRounds: settings.agent.goalMaxRounds,
    },
    models: {
      getSettings: () => getKanaModelManagement(settings),
    },
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
