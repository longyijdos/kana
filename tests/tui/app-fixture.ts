import type { Agent } from "../../src/agent";
import type { KanaTuiAppOptions } from "../../src/tui/app/app";
import type { Terminal } from "../../src/tui/runtime";
import { withAgentInboxForTest } from "../helpers/agent-inbox";

type TerminalInputHandler = Parameters<Terminal["start"]>[0];

export function createTuiAgentStub(): Agent {
  return withAgentInboxForTest({
    state: {
      messages: [],
      model: {
        metadata: {
          provider: "test",
          model: "test-model",
          contextWindow: 1,
          maxOutputTokens: 1,
        },
      },
    },
    abort() {},
    async waitForIdle() {},
  }) as unknown as Agent;
}

export function createTuiAppOptions(): KanaTuiAppOptions {
  return {
    launch: {},
    conversation: {
      getResumeSessionId: () => undefined,
      createNewSession: () => ({ id: "new" }),
      forkSession: () => ({ id: "fork" }),
      listSessions: () => [],
      loadSession: () => ({ id: "session", messages: [], timeline: [] }),
      deleteSession: () => false,
      goalMaxRounds: 8,
    },
    skills: {
      load: () => ({ skills: [], globalEnabledSkillNames: [], diagnostics: [] }),
      saveEnabledGlobalNames: () => {},
    },
    toolApproval: {
      config: { mode: "unless_trusted" },
      approvals: {
        version: 2,
        bash: { exactCommands: [], readOnlyCommands: [] },
      },
    },
    ui: {
      notification: {
        backend: "off",
        onAgentCompleted: false,
        onApprovalRequired: false,
      },
    },
    memory: { compact: async () => [], load: () => "" },
    usage: {
      load: (scope) => ({
        scope,
        runCount: 0,
        mainRunCount: 0,
        memoryRunCount: 0,
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
          main: { runCount: 0 },
          memoryAutomatic: { runCount: 0 },
          memoryManual: { runCount: 0 },
        },
        models: [],
      }),
    },
  };
}

export function createTerminalStub(
  captureInput?: (onInput: TerminalInputHandler) => void,
): Terminal {
  return {
    columns: 80,
    rows: 24,
    start: (onInput) => captureInput?.(onInput),
    stop: () => {},
    write: () => {},
    notify: () => {},
  };
}
