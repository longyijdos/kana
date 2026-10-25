import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { createServerApi } from "../../src/server/api";
import { waitFor } from "../helpers/async-control";
import { ControlledModel } from "../helpers/controlled-model";
import { createFixture } from "./fixture";

describe("server HTTP API", () => {
  test("requires a token, authenticates every route, and validates requests", async () => {
    const f = createFixture();
    try {
      expect(() => createServerApi({ ...f.apiOptions, token: " " })).toThrow("KANA_SERVER_TOKEN");
      for (const path of ["/v1/state", "/v1/events", "/v1/sessions", "/v1/approvals", "/missing"]) {
        expect((await fetch(new URL(path, f.url))).status).toBe(401);
      }
      expect(
        (
          await fetch(new URL("/v1/state", f.url), {
            headers: { Authorization: "Bearer wrong-token" },
          })
        ).status,
      ).toBe(401);
      expect((await f.request("/missing")).status).toBe(404);
      expect(
        (await f.request("/v1/messages", "POST", { message: "hi", session_id: "old" })).status,
      ).toBe(409);
      for (const body of [null, [], {}, { message: " " }, { message: "hi", delivery: "invalid" }]) {
        expect((await f.request("/v1/messages", "POST", body)).status).toBe(400);
      }
      const malformed = await fetch(new URL("/v1/messages", f.url), {
        method: "POST",
        headers: { Authorization: "Bearer test-secret" },
        body: "{",
      });
      expect(malformed.status).toBe(400);
      expect(f.runtime.state.messages).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  test("accepts a run, streams its events, and retains history after client disconnect", async () => {
    const f = createFixture({ context: { contextLimit: 32_000, maxOutputTokens: 512 } });
    try {
      const initialTokens = f.runtime.estimateContextTokens();
      const response = await f.request("/v1/events");
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const reader = response.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain("event: snapshot");
      expect(first).toContain('"schema_version":1');
      expect(first).toContain('"session_id":"session-a"');
      const snapshotData = first.split("\n").find((line) => line.startsWith("data: "))!;
      expect(JSON.parse(snapshotData.slice("data: ".length)).data.context).toEqual({
        estimated_tokens: initialTokens,
        context_limit: 32_000,
      });
      const accepted = await f.request("/v1/messages", "POST", {
        session_id: "session-a",
        message: "Hello",
      });
      expect(accepted.status).toBe(202);
      const result = await accepted.json();
      expect(result.data.delivery).toBe("submitted");
      await waitFor(() => !f.runtime.isRunning);
      let output = "";
      while (!output.includes("event: run.completed")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += new TextDecoder().decode(chunk.value);
      }
      expect(output).toContain("event: assistant.delta");
      expect(output).toContain("event: assistant.completed");
      await reader.cancel();
      const state = await (await f.request("/v1/state")).json();
      expect(state.data.session.messages.map((message: { role: string }) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(state.data.run).toMatchObject({ status: "completed", outcome: "stop" });
      expect(state.data.context.estimated_tokens).toBeGreaterThan(initialTokens!);
      expect(state.data.context.context_limit).toBe(32_000);
      const updates = output
        .split("\n\n")
        .filter((frame) => frame.startsWith("event: context.updated\n"))
        .map((frame) => JSON.parse(frame.split("\n")[1]!.slice("data: ".length)));
      expect(updates.at(-1).data).toEqual(state.data.context);
      const reconnect = await f.request("/v1/events");
      const reconnectReader = reconnect.body!.getReader();
      try {
        const first = new TextDecoder().decode((await reconnectReader.read()).value);
        const data = first.split("\n").find((line) => line.startsWith("data: "))!;
        expect(JSON.parse(data.slice("data: ".length)).data.context).toEqual(state.data.context);
      } finally {
        await reconnectReader.cancel();
      }
    } finally {
      await f.close();
    }
  });

  test("encodes BigInt tool results in live events, state and reconnect snapshots", async () => {
    const model = new ControlledModel();
    const result = { count: 9_007_199_254_740_993n, values: [0n, -2n], nested: { total: 3n } };
    const encoded = { count: "9007199254740993", values: ["0", "-2"], nested: { total: "3" } };
    const f = createFixture({
      model,
      approvalMode: "never",
      tools: [
        {
          name: "bigint_result",
          description: "Returns an execution-local BigInt result",
          parameters: Type.Object({}),
          execute: () => ({ content: "ok", result }),
        },
      ],
    });
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    try {
      const subscribe = () =>
        fetch(new URL("/v1/events", f.url), {
          headers: { Authorization: "Bearer test-secret" },
          signal: AbortSignal.timeout(2_000),
        });
      const response = await subscribe();
      const reader = response.body!.getReader();
      readers.push(reader);
      await reader.read();
      await f.request("/v1/messages", "POST", { session_id: "session-a", message: "Work" });
      await waitFor(() => model.requests.length === 1);
      model.requests[0]!.complete(
        [{ type: "tool_call", id: "bigint-call", name: "bigint_result", args: {} }],
        "toolUse",
      );
      await waitFor(() => model.requests.length === 2);
      const decoder = new TextDecoder();
      let output = "";
      while (!output.includes("event: tool.completed")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += decoder.decode(chunk.value, { stream: true });
      }
      const toolFrame = output
        .split("\n\n")
        .find((frame) => frame.startsWith("event: tool.completed\n"));
      expect(toolFrame).toBeDefined();
      const event = JSON.parse(toolFrame!.split("\n")[1]!.slice("data: ".length));
      expect(event.data.result).toEqual(encoded);
      const stateResponse = await f.request("/v1/state");
      expect(stateResponse.status).toBe(200);
      expect(stateResponse.headers.get("content-type")).toBe("application/json");
      const state = await stateResponse.json();
      expect(state.data.tools[0].result).toEqual(encoded);
      const reconnected = await subscribe();
      const reconnectReader = reconnected.body!.getReader();
      readers.push(reconnectReader);
      const first = decoder.decode((await reconnectReader.read()).value);
      const snapshot = JSON.parse(
        first
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice("data: ".length),
      );
      expect(snapshot.type).toBe("snapshot");
      expect(snapshot.data.tools[0].result).toEqual(encoded);
      expect(result.count).toBe(9_007_199_254_740_993n);
      model.requests[1]!.complete("Done.");
      await waitFor(() => !f.runtime.isRunning);
    } finally {
      await Promise.all(readers.map((reader) => reader.cancel().catch(() => {})));
      await f.close();
    }
  });

  test("reconnects with partial text, keeps running offline, queues input and refuses busy session changes", async () => {
    const model = new ControlledModel();
    const f = createFixture({ model });
    try {
      const disconnected = await f.request("/v1/events");
      await disconnected.body!.cancel();
      expect(
        (await f.request("/v1/messages", "POST", { session_id: "session-a", message: "First" }))
          .status,
      ).toBe(202);
      await waitFor(() => model.requests.length === 1);
      model.requests[0]!.update("Partial");
      await waitFor(() => f.runtime.state.messages.length === 1);
      const busy = await f.request("/v1/sessions", "POST");
      expect(busy.status).toBe(409);
      const queued = await f.request("/v1/messages", "POST", {
        session_id: "session-a",
        message: "Second",
        delivery: "queue",
      });
      expect((await queued.json()).data.delivery).toBe("queued");
      const reconnect = await f.request("/v1/events");
      const reader = reconnect.body!.getReader();
      const text = new TextDecoder().decode((await reader.read()).value);
      expect(text).toContain('"text":"Partial"');
      expect(text).toContain('"running":true');
      await reader.cancel();
      expect(f.runtime.isRunning).toBe(true);
      model.requests[0]!.complete("Done.");
      await waitFor(() => model.requests.length === 2);
      model.requests[1]!.complete("Done.");
      await waitFor(() => !f.runtime.isRunning);
      expect(
        f.runtime.state.messages.filter((m) => m.role === "user").map((m) => m.content),
      ).toEqual(["First", "Second"]);
    } finally {
      await f.close();
    }
  });

  test("starts new, forks, resumes and deletes only saved non-active sessions", async () => {
    const f = createFixture();
    try {
      expect((await f.request("/v1/sessions/session-a", "DELETE")).status).toBe(404);
      expect((await f.request("/v1/sessions/missing/resume", "POST")).status).toBe(404);
      const created = await (await f.request("/v1/sessions", "POST")).json();
      expect(created.data.session_id).toBe("session-1");
      const list = await (await f.request("/v1/sessions")).json();
      expect(list.data.current_session_id).toBe("session-1");
      expect(list.data.sessions.map((s: { id: string }) => s.id)).toEqual(["session-a"]);
      expect(
        (await f.request("/v1/sessions/fork", "POST", { session_id: "session-1" })).status,
      ).toBe(201);
      expect((await f.request("/v1/sessions/session-a/resume", "POST")).status).toBe(200);
      expect(f.runtime.sessionId).toBe("session-a");
      expect((await f.request("/v1/sessions/session-1", "DELETE")).status).toBe(200);
    } finally {
      await f.close();
    }
  });

  test("reports sessions owned by another process as in use", async () => {
    const f = createFixture({ inUseSessionIds: ["session-b"] });
    try {
      const inUse = {
        code: "session_in_use",
        message: "Kana session session-b is in use by another Kana conversation.",
      };
      const resumed = await f.request("/v1/sessions/session-b/resume", "POST");
      expect(resumed.status).toBe(409);
      expect((await resumed.json()).error).toEqual(inUse);
      expect(f.runtime.sessionId).toBe("session-a");
      const deleted = await f.request("/v1/sessions/session-b", "DELETE");
      expect(deleted.status).toBe(409);
      expect((await deleted.json()).error).toEqual(inUse);
    } finally {
      await f.close();
    }
  });

  test("stops an active run through the authenticated API", async () => {
    const model = new ControlledModel();
    const f = createFixture({ model });
    try {
      await f.request("/v1/messages", "POST", { session_id: "session-a", message: "Work" });
      await waitFor(() => model.requests.length === 1);
      expect((await f.request("/v1/abort", "POST", { session_id: "session-a" })).status).toBe(202);
      await waitFor(() => !f.runtime.isRunning);
      expect(model.requests[0]!.context.signal?.aborted).toBe(true);
    } finally {
      await f.close();
    }
  });

  test("blocks untrusted tools for remote approval and settles approval on abort", async () => {
    const model = new ControlledModel();
    let executions = 0;
    const f = createFixture({
      model,
      tools: [
        {
          name: "write_test",
          description: "Test",
          parameters: Type.Object({}),
          execute: () => {
            executions++;
            return { content: "ok", result: "ok" };
          },
        },
      ],
    });
    try {
      await f.request("/v1/messages", "POST", { session_id: "session-a", message: "Work" });
      await waitFor(() => model.requests.length === 1);
      model.requests[0]!.complete(
        [{ type: "tool_call", id: "call-0", name: "write_test", args: {} }],
        "toolUse",
      );
      let id = "";
      for (let i = 0; i < 100 && !id; i++) {
        const pending = await (await f.request("/v1/approvals")).json();
        id = pending.data[0]?.id ?? "";
      }
      expect(id).not.toBe("");
      expect(executions).toBe(0);
      expect(
        (
          await f.request(`/v1/approvals/${id}`, "POST", {
            session_id: "session-a",
            decision: "always",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await f.request(`/v1/approvals/${id}`, "POST", {
            session_id: "session-a",
            decision: "allow",
          })
        ).status,
      ).toBe(200);
      await waitFor(() => model.requests.length === 2);
      expect(executions).toBe(1);
      model.requests[1]!.complete(
        [{ type: "tool_call", id: "call-1", name: "write_test", args: {} }],
        "toolUse",
      );
      let secondId = "";
      for (let i = 0; i < 100 && !secondId; i++) {
        secondId = (await (await f.request("/v1/approvals")).json()).data[0]?.id ?? "";
      }
      expect(secondId).not.toBe("");
      await f.request("/v1/abort", "POST", { session_id: "session-a" });
      await waitFor(() => !f.runtime.isRunning);
      expect((await (await f.request("/v1/approvals")).json()).data).toEqual([]);
      expect(executions).toBe(1);
      expect(
        (
          await f.request(`/v1/approvals/${secondId}`, "POST", {
            session_id: "session-a",
            decision: "allow",
          })
        ).status,
      ).toBe(404);
    } finally {
      await f.close();
    }
  });

  test("starts and cancels goals", async () => {
    const model = new ControlledModel();
    const f = createFixture({ model });
    try {
      for (const body of [{}, { objective: " " }]) {
        expect((await f.request("/v1/goal", "POST", body)).status).toBe(400);
      }
      expect(
        (await f.request("/v1/goal", "POST", { session_id: "old", objective: "Ship" })).status,
      ).toBe(409);
      const started = await f.request("/v1/goal", "POST", {
        session_id: "session-a",
        objective: " Ship the release ",
      });
      expect(started.status).toBe(202);
      expect((await started.json()).data.goal).toMatchObject({
        objective: "Ship the release",
        status: "active",
        maxRounds: 8,
      });
      await waitFor(() => model.requests.length === 1);
      expect(
        (await f.request("/v1/goal", "POST", { session_id: "session-a", objective: "Again" }))
          .status,
      ).toBe(409);
      const cancelled = await f.request("/v1/goal/cancel", "POST", { session_id: "session-a" });
      expect((await cancelled.json()).data).toEqual({ cancelled: true });
      model.requests[0]!.complete("Working on it.");
      await waitFor(() => !f.runtime.isRunning);
      expect(model.requests).toHaveLength(1);
      const state = await (await f.request("/v1/state")).json();
      expect(state.data.goal.status).toBe("cancelled");
      expect((await f.request("/v1/goal/cancel", "POST", { session_id: "session-a" })).status).toBe(
        404,
      );
    } finally {
      await f.close();
    }
  });

  test("schedules one-shot and repeating messages and cancels them", async () => {
    const f = createFixture();
    try {
      for (const body of [
        { message: "hi" },
        { message: "hi", after_minutes: 0 },
        { message: "hi", after_minutes: 1.5 },
        { message: "hi", after_minutes: 1_441 },
        { message: " ", after_minutes: 5 },
        { message: "x".repeat(4_001), after_minutes: 5 },
        { message: "hi", after_minutes: 5, repeat: "yes" },
      ]) {
        expect(
          (await f.request("/v1/schedules", "POST", { session_id: "session-a", ...body })).status,
        ).toBe(400);
      }
      const once = await f.request("/v1/schedules", "POST", {
        session_id: "session-a",
        message: " Check the build ",
        after_minutes: 30,
      });
      expect(once.status).toBe(201);
      const onceData = (await once.json()).data.scheduled;
      expect(onceData).toMatchObject({ message: "Check the build", origin: "user" });
      expect(onceData.everyMinutes).toBeUndefined();
      const repeating = await f.request("/v1/schedules", "POST", {
        session_id: "session-a",
        message: "Summarize the inbox",
        after_minutes: 60,
        repeat: true,
      });
      const repeatingData = (await repeating.json()).data.scheduled;
      expect(repeatingData.everyMinutes).toBe(60);
      const state = await (await f.request("/v1/state")).json();
      expect(state.data.input_queue.scheduled.map((item: { id: string }) => item.id)).toEqual([
        onceData.id,
        repeatingData.id,
      ]);
      const cancel = (id: string) =>
        f.request(`/v1/schedules/${id}/cancel`, "POST", { session_id: "session-a" });
      expect((await (await cancel(repeatingData.id)).json()).data).toEqual({
        cancelled: "future",
      });
      expect((await cancel(repeatingData.id)).status).toBe(404);
      expect((await cancel(onceData.id)).status).toBe(200);
      expect(f.runtime.inputQueue.scheduled).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
