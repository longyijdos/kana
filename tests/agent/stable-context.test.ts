import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { Agent, type AgentStableContext } from "../../src/agent";
import { createUserMessage, type Message } from "../../src/core";
import { deferred, waitFor } from "../helpers/async-control";
import { ControlledModel } from "../helpers/controlled-model";
import { messageIdentityForTest } from "../helpers/messages";

describe("stable Agent context", () => {
  for (const journaled of [false, true]) {
    test(`captures complete turns and consumed input with journal=${journaled}`, async () => {
      const model = new ControlledModel();
      const results = [deferred(), deferred()];
      const committed: Message[] = [];
      const agent = new Agent({
        model,
        system: "Main instructions",
        tools: [
          {
            name: "probe",
            description: "Probe",
            execution: { concurrency: "parallel" },
            parameters: Type.Object({ index: Type.Number() }),
            execute: async ({ index }) => {
              await results[index]!.promise;
              return { content: `result ${index}` };
            },
          },
        ],
        journal: journaled
          ? {
              startRun: () => {},
              appendMessage: ({ message }) => {
                committed.push(message);
              },
              appendCompaction: () => {},
              endRun: () => {},
            }
          : undefined,
      });
      const boundaries: Array<{ type: string; snapshot: AgentStableContext }> = [];
      agent.subscribe((event) => {
        if (event.type === "turn_end" || event.type === "turn_input") {
          boundaries.push({ type: event.type, snapshot: agent.getStableContext() });
        }
      });
      const run = agent.stream("Main task");
      await waitFor(() => model.requests.length === 1);
      expect(agent.getStableContext().messages).toMatchObject([{ content: "Main task" }]);
      model.requests[0]!.complete(
        [0, 1].map((index) => ({
          type: "tool_call",
          id: `probe-${index}`,
          name: "probe",
          args: { index },
        })),
        "toolUse",
      );
      const steeringInput = createUserMessage({
        content: "New direction",
        provenance: { kind: "user_input" },
      });
      const steering = agent.steer(steeringInput);
      const firstResult = deferred();
      const unsubscribe = agent.subscribe((event) => {
        if (event.type === "tool_execution_end" && event.toolCallId === "probe-0") {
          firstResult.resolve();
        }
      });
      results[0]!.resolve();
      await firstResult.promise;
      if (journaled) {
        await waitFor(() => committed.some((message) => message.role === "tool"));
        expect(committed.map((message) => message.role)).toEqual(["assistant", "tool"]);
      }
      expect(agent.getStableContext().messages).toMatchObject([{ content: "Main task" }]);
      results[1]!.resolve();
      await waitFor(() => model.requests.length === 2);
      expect(await steering).toBe("consumed");
      expect(boundaries[0]?.type).toBe("turn_end");
      expect(boundaries[0]?.snapshot.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "tool",
      ]);
      expect(boundaries[1]?.type).toBe("turn_input");
      expect(boundaries[1]?.snapshot.messages.at(-1)).toEqual(steeringInput);
      expect(boundaries[1]?.snapshot.system).toBe("Main instructions");
      model.requests[1]!.update("Partial answer");
      await waitFor(() => agent.state.streamingMessage?.content.length === 1);
      expect(agent.getStableContext().messages).toEqual(boundaries[1]?.snapshot.messages);
      model.requests[1]!.complete("Final answer");
      await run.result();
      await agent.waitForIdle();
      expect(agent.getStableContext().messages).toEqual(agent.state.messages);
      const detached = agent.getStableContext();
      detached.messages.length = 0;
      expect(agent.getStableContext().messages).toHaveLength(6);
      agent.reset();
      expect(agent.getStableContext().messages).toEqual([]);
      unsubscribe();
    });
  }

  test("keeps the checkpoint paired with its stable messages during compaction", async () => {
    const model = new ControlledModel();
    const messages: Message[] = [
      createUserMessage({ content: "old ".repeat(2_000), provenance: { kind: "user_input" } }),
      {
        ...messageIdentityForTest("assistant"),
        role: "assistant",
        content: [{ type: "text", text: "Previous answer" }],
      },
    ];
    const agent = new Agent({
      model,
      messages,
      context: {
        contextLimit: 2_048,
        maxOutputTokens: 256,
        compactPolicy: async () => ({ summary: "Previous conversation." }),
      },
      journal: {
        startRun: () => {},
        appendMessage: () => {},
        appendCompaction: () => {},
        endRun: () => {},
      },
    });
    const run = agent.stream("Current task");
    await waitFor(() => model.requests.length === 1);
    expect(agent.state.contextCheckpoint).toBeDefined();
    expect(agent.getStableContext().contextCheckpoint).toBeUndefined();
    expect(agent.getStableContext().messages).toHaveLength(3);
    model.requests[0]!.complete("Answer");
    await run.result();
    await agent.waitForIdle();
    const snapshot = agent.getStableContext();
    expect(snapshot.contextCheckpoint).toEqual(agent.state.contextCheckpoint);
    expect(snapshot.contextLimit).toBe(2_048);
    expect(snapshot.maxOutputTokens).toBe(256);
    snapshot.contextCheckpoint!.summary = "Mutated";
    expect(agent.getStableContext().contextCheckpoint?.summary).toBe("Previous conversation.");
  });

  test("retains safe partial text when the model is aborted", async () => {
    const model = new ControlledModel();
    const agent = new Agent({ model });
    const run = agent.stream("Task");
    await waitFor(() => model.requests.length === 1);
    model.requests[0]!.update("Partial answer");
    agent.abort();
    await run.result();
    expect(agent.getStableContext().messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "aborted",
      content: [{ type: "text", text: "Partial answer" }],
    });
  });

  test("does not expose calls left unexecuted by a truncated response", async () => {
    const model = new ControlledModel();
    const agent = new Agent({ model });
    const run = agent.stream("Task");
    await waitFor(() => model.requests.length === 1);
    model.requests[0]!.complete(
      [{ type: "tool_call", id: "unexecuted", name: "probe", args: {} }],
      "length",
    );
    await run.result();
    expect(agent.getStableContext().messages).toMatchObject([{ content: "Task" }]);
  });
});
