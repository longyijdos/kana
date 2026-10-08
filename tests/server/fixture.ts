import { Agent, type AgentConfig } from "../../src/agent";
import type { Model } from "../../src/core";
import {
  ConversationRuntime,
  type ConversationSessionSnapshot,
  type KanaSessionMetadata,
  type KanaToolApprovalConfig,
  type KanaToolApprovals,
} from "../../src/kana";
import { createNoopLogger } from "../../src/logging";
import { MockModel } from "../../src/providers/mock";
import { createServerApi } from "../../src/server/api";
import type { Tool } from "../../src/tools";

export function createFixture(
  options: {
    model?: Model;
    tools?: Tool[];
    session?: ConversationSessionSnapshot;
    approvalMode?: KanaToolApprovalConfig["mode"];
    context?: AgentConfig["context"];
  } = {},
) {
  const sessions = new Map<string, KanaSessionMetadata>();
  let counter = 0;
  const trusted: KanaToolApprovals = {
    version: 3,
    shell: { exactCommands: [], readOnlyCommands: [] },
  };
  function newSession(id: string) {
    const date = new Date().toISOString();
    sessions.set(id, {
      id,
      createdAt: date,
      updatedAt: date,
      title: id,
      cwd: "/tmp",
      path: `/tmp/${id}`,
    });
    return { id, messages: [], timeline: [] };
  }
  const runtime = new ConversationRuntime({
    initialSession: options.session ?? newSession("session-a"),
    createNewSession: () => newSession(`session-${++counter}`),
    forkSession: () => newSession(`fork-${++counter}`),
    loadSession: (id) => newSession(id),
    listSessions: () => [...sessions.values()],
    deleteSession: (id) => sessions.delete(id),
    goalMaxRounds: 8,
    createAgent: (agentOptions) =>
      new Agent({
        model:
          options.model ?? new MockModel({ provider: "mock", model: "mock", response: "Done." }),
        messages: agentOptions.messages,
        inbox: agentOptions.inbox,
        beforeToolExecution: agentOptions.beforeToolExecution,
        tools: options.tools,
        context: options.context
          ? { ...options.context, checkpoint: agentOptions.contextCheckpoint }
          : undefined,
      }),
  });
  const apiOptions = {
    token: "test-secret",
    runtime,
    getApprovalConfig: () => ({ mode: options.approvalMode ?? "unless_trusted" }) as const,
    getApprovals: () => trusted,
    addTrustedShellCommand: (command: string) => {
      trusted.shell.exactCommands.push(command);
    },
    getLogger: createNoopLogger,
  };
  const api = createServerApi(apiOptions);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: api.fetch });
  return {
    api,
    apiOptions,
    runtime,
    async request(path: string, method = "GET", body?: unknown) {
      return fetch(new URL(path, server.url), {
        method,
        headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
    url: server.url,
    async close() {
      api.close();
      await server.stop(true);
      await runtime.close();
    },
  };
}
