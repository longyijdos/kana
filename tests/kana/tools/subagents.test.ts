import { describe, expect, test } from "bun:test";
import {
  KanaSubagentManager,
  type KanaSubagentProfile,
  type KanaSubagentRunResult,
} from "../../../src/kana/subagents";
import {
  createCancelSubagentTool,
  createContinueSubagentTool,
  createSpawnSubagentTool,
  createWaitSubagentTool,
} from "../../../src/kana/tools";
import { createToolContext, expectToolResult } from "../../tools/workspace-fixture";

describe("subagent tools", () => {
  test("uses the invocation signal only to gate spawn", async () => {
    const manager = new KanaSubagentManager();
    const client = manager.bind(
      manager.createOwner({ sessionId: "session-1", cwd: process.cwd(), persistent: false }),
      { maxLive: 2 },
    );
    const run = deferred<KanaSubagentRunResult>();
    const spawn = createSpawnSubagentTool({
      subagents: client,
      profiles: [profile()],
      availableTools: () => ["read"],
      run: () => run.promise,
    });
    const wait = createWaitSubagentTool(client);
    expect(spawn.description.toLowerCase()).toContain("completion is delivered");
    expect(spawn.description.toLowerCase()).toContain("do not poll wait_subagent solely");
    expect(wait.description.toLowerCase()).toContain("notify the parent agent automatically");
    expect(wait.description.toLowerCase()).toContain("instead of repeatedly polling");
    const invocation = new AbortController();
    const started = await spawn.execute(
      { profile: "explorer", task: "Inspect the parser" },
      { ...createToolContext(), signal: invocation.signal },
    );
    expectToolResult<{ agentId: string }>(started);
    expect(started.result).toEqual({ agentId: expect.any(String), status: "running" });
    expect(JSON.parse(started.content)).toEqual(started.result);

    invocation.abort();
    await Promise.resolve();
    expect(client.inspect(started.result.agentId)?.status).toBe("running");

    const running = await wait.execute({ agentId: started.result.agentId }, createToolContext());
    expectToolResult(running);
    expect(running.result).toEqual({
      status: "running",
      runNumber: 1,
      output: "",
      waitTimedOut: false,
    });
    expect(running.content).not.toContain("agentId:");
    expect(running.content).not.toContain("profile:");

    run.resolve(result("done"));
    const completed = await wait.execute(
      { agentId: started.result.agentId, timeoutMs: 100 },
      createToolContext(),
    );
    expectToolResult(completed);
    expect(completed.result).toEqual({
      status: "completed",
      runNumber: 1,
      output: "done",
      terminalReason: "stop",
      waitTimedOut: false,
    });
    const cancel = createCancelSubagentTool(client);
    const cancelled = await cancel.execute(
      { agentId: started.result.agentId },
      createToolContext(),
    );
    expectToolResult(cancelled);
    expect(cancelled.result).toEqual({ status: "completed", terminalReason: "stop" });
    expect(JSON.parse(cancelled.content)).toEqual(cancelled.result);

    const cancelledInvocation = new AbortController();
    cancelledInvocation.abort();
    expect(() =>
      spawn.execute(
        { profile: "explorer", task: "Do not start" },
        { ...createToolContext(), signal: cancelledInvocation.signal },
      ),
    ).toThrow("Subagent spawn was cancelled.");
    expect(client.list()).toHaveLength(1);
    await manager.close();
  });

  test("starts a follow-up under the same ID and reports its new run separately", async () => {
    const manager = new KanaSubagentManager();
    const client = manager.bind(
      manager.createOwner({ sessionId: "session-1", cwd: process.cwd(), persistent: false }),
      { maxLive: 1 },
    );
    const { id } = client.start({
      profile: profile(),
      task: "Inspect the parser",
      spawnToolCallId: "spawn",
      run: async () => ({
        ...result("first result"),
        continuation: async ({ message }) => result(`Followed up: ${message}`),
      }),
    });
    await client.wait(id, { waitMs: 100 });
    const tool = createContinueSubagentTool(client);
    expect(() => tool.execute({ agentId: id, message: "  " }, createToolContext())).toThrow(
      "Subagent follow-up message is required.",
    );
    const continued = await tool.execute(
      { agentId: id, message: " Explain the result " },
      createToolContext(),
    );
    expectToolResult(continued);
    expect(continued.result).toEqual({ agentId: id, runNumber: 2, status: "running" });
    const read = await createWaitSubagentTool(client).execute(
      { agentId: id, timeoutMs: 100 },
      createToolContext(),
    );
    expectToolResult(read);
    expect(read.result).toMatchObject({
      runNumber: 2,
      status: "completed",
      output: "Followed up: Explain the result",
    });
    await manager.close();
  });

  test("returns a failed subagent run as a successful read", async () => {
    const manager = new KanaSubagentManager();
    const client = manager.bind(
      manager.createOwner({ sessionId: "session-1", cwd: process.cwd(), persistent: false }),
      { maxLive: 1 },
    );
    const agent = client.start({
      profile: profile(),
      task: "Inspect the parser",
      spawnToolCallId: "spawn",
      run: async () => ({
        status: "errored",
        terminalReason: "error",
        output: "Partial findings",
        error: "Child run failed",
        messages: [],
      }),
    });
    const wait = createWaitSubagentTool(client);
    const read = await wait.execute({ agentId: agent.id, timeoutMs: 100 }, createToolContext());
    expectToolResult(read);
    expect(read.isError).toBe(false);
    expect(read.result).toEqual({
      status: "errored",
      runNumber: 1,
      terminalReason: "error",
      output: "Partial findings",
      error: "Child run failed",
      waitTimedOut: false,
    });

    const missing = await wait.execute({ agentId: "missing" }, createToolContext());
    expectToolResult(missing);
    expect(missing.isError).toBe(true);
    await manager.close();
  });
});

function profile(): KanaSubagentProfile {
  return {
    name: "explorer",
    description: "Explore",
    instructions: "Inspect only.",
    tools: ["read"],
    digest: "profile-digest",
  };
}

function result(output: string): KanaSubagentRunResult {
  return {
    status: "completed",
    output,
    messages: [],
    terminalReason: "stop",
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
