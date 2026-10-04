import { describe, expect, test } from "bun:test";
import {
  KanaSubagentManager,
  type KanaSubagentProfile,
  type KanaSubagentRunResult,
} from "../../../src/kana/subagents";
import {
  createCancelSubagentTool,
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
    expect(running.result).toEqual({ status: "running", output: "", waitTimedOut: false });
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
