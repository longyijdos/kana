import { describe, expect, test } from "bun:test";
import { AgentInbox } from "@/agent";
import { createUserMessage } from "@/core";

describe("AgentInbox", () => {
  test("keeps identical content distinct and rejects one ID in two lanes", () => {
    const first = createUserMessage({
      content: "Same text.",
      provenance: { kind: "user_input" },
    });
    const second = createUserMessage({
      content: "Same text.",
      provenance: { kind: "user_input" },
    });
    const inbox = new AgentInbox();

    inbox.enqueue({ message: first, delivery: { kind: "steering" } }, "next-step");
    inbox.enqueue({ message: second, delivery: { kind: "queued" } }, "next-turn");

    expect(inbox.snapshot.nextStep.map((item) => item.message.id)).toEqual([first.id]);
    expect(inbox.snapshot.nextTurn.map((item) => item.message.id)).toEqual([second.id]);
    expect(() =>
      inbox.enqueue({ message: first, delivery: { kind: "queued" } }, "next-turn"),
    ).toThrow("already pending");
  });

  test("defers next-step input to the existing next-turn tail without changing IDs", () => {
    const queued = createUserMessage({
      content: "Queued first.",
      provenance: { kind: "user_input" },
    });
    const firstSteer = createUserMessage({
      content: "Steer one.",
      provenance: { kind: "user_input" },
    });
    const secondSteer = createUserMessage({
      content: "Steer two.",
      provenance: { kind: "user_input" },
    });
    const inbox = new AgentInbox();
    inbox.enqueue({ message: queued, delivery: { kind: "queued" } }, "next-turn");
    inbox.enqueue({ message: firstSteer, delivery: { kind: "steering" } }, "next-step");
    inbox.enqueue({ message: secondSteer, delivery: { kind: "steering" } }, "next-step");

    const deferred = inbox.deferNextStep();

    expect(deferred.map((item) => item.message.id)).toEqual([firstSteer.id, secondSteer.id]);
    expect(inbox.snapshot.nextStep).toEqual([]);
    expect(inbox.snapshot.nextTurn.map((item) => item.message.id)).toEqual([
      queued.id,
      firstSteer.id,
      secondSteer.id,
    ]);
  });
});
