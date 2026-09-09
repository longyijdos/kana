import { describe, expect, test } from "bun:test";
import {
  KanaSubagentManager,
  type KanaSubagentProfile,
  type KanaSubagentRunResult,
} from "../../../src/kana/subagents";
import { createSpawnSubagentTool, createWaitSubagentTool } from "../../../src/kana/tools";
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

    invocation.abort();
    await Promise.resolve();
    expect(client.inspect(started.result.agentId)?.status).toBe("running");

    run.resolve(result("done"));
    await expect(client.wait(started.result.agentId, { waitMs: 100 })).resolves.toMatchObject({
      status: "completed",
      output: "done",
    });

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
    source: "builtin",
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
