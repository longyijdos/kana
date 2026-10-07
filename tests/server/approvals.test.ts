import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import type { KanaToolApprovals } from "../../src/kana";
import { ServerApprovals } from "../../src/server/approvals";

function fixture() {
  const events: string[] = [];
  const trusted: KanaToolApprovals = {
    version: 3,
    shell: { exactCommands: [], readOnlyCommands: [] },
  };
  const approvals = new ServerApprovals({
    getSessionId: () => "session-a",
    getConfig: () => ({ mode: "unless_trusted" }),
    getApprovals: () => trusted,
    addTrustedShellCommand: (command) => {
      trusted.shell.exactCommands.push(command);
    },
    emit: (type) => {
      events.push(type);
    },
  });
  function request(name = "shell", signal?: AbortSignal) {
    return approvals.request({
      agent: { id: "main", label: "main", kind: "main" },
      toolCall: {
        type: "tool_call",
        id: crypto.randomUUID(),
        name,
        args: { command: "echo test" },
      },
      tool: {
        name,
        description: "Test",
        parameters: Type.Object({}),
        execute: () => ({ content: "ok", result: "ok" }),
      },
      args: { command: "echo test" },
      signal,
    });
  }
  return { approvals, events, trusted, request };
}

describe("server approvals", () => {
  test("uses shared trust rules and supports allow, reject and stale decisions", async () => {
    const f = fixture();
    expect(f.request("read")).toEqual({ type: "continue" });
    const first = f.request();
    const id = f.approvals.snapshot[0]!.id;
    expect(f.approvals.decide(id, "allow")).toBe("resolved");
    expect(await first).toEqual({ type: "continue" });
    expect(f.approvals.decide(id, "allow")).toBe("not_found");
    const second = f.request();
    f.approvals.decide(f.approvals.snapshot[0]!.id, "reject");
    expect(await second).toMatchObject({ type: "cancel", abortRun: true });
    expect(f.events).toEqual([
      "approval.required",
      "approval.resolved",
      "approval.required",
      "approval.resolved",
    ]);
  });

  test("permanent command trust releases matching pending approvals", async () => {
    const f = fixture();
    const first = f.request();
    const second = f.request();
    f.approvals.decide(f.approvals.snapshot[0]!.id, "always");
    expect(await first).toEqual({ type: "continue" });
    expect(await second).toEqual({ type: "continue" });
    expect(f.trusted.shell.exactCommands).toEqual(["echo test"]);
    expect(f.approvals.snapshot).toEqual([]);
    expect(f.request()).toEqual({ type: "continue" });
    const file = f.request("write");
    expect(f.approvals.decide(f.approvals.snapshot[0]!.id, "always")).toBe("invalid");
    f.approvals.close();
    expect(await file).toMatchObject({ type: "cancel" });
  });

  test("temporary never resets at session boundaries; cancellation and close settle pending requests", async () => {
    const f = fixture();
    const first = f.request();
    const second = f.request("write");
    f.approvals.decide(f.approvals.snapshot[0]!.id, "never");
    expect(await first).toEqual({ type: "continue" });
    expect(await second).toEqual({ type: "continue" });
    expect(f.request("write")).toEqual({ type: "continue" });
    f.approvals.resetSession();
    const controller = new AbortController();
    const cancelled = f.request("write", controller.signal);
    controller.abort();
    expect(await cancelled).toMatchObject({ type: "cancel", abortRun: true });
    expect(f.approvals.snapshot).toEqual([]);
    expect(f.request("write", controller.signal)).toMatchObject({ type: "cancel" });
    const last = f.request("write");
    f.approvals.close();
    expect(await last).toMatchObject({ type: "cancel" });
    expect(f.request()).toMatchObject({ type: "cancel" });
  });
});
