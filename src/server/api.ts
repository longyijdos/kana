import { timingSafeEqual } from "node:crypto";
import { createUserMessage } from "@/core";
import type {
  ConversationRuntime,
  KanaLaunchMode,
  KanaToolApprovalConfig,
  KanaToolApprovals,
} from "@/kana";
import type { Logger } from "@/logging";
import { type ApprovalDecision, ServerApprovals } from "./approvals";
import { ServerProjection } from "./projection";
import { projectError, type ServerEvent, type ServerEventType } from "./protocol";

export type ServerApiOptions = {
  token: string;
  runtime: ConversationRuntime;
  launchMode?: KanaLaunchMode;
  getApprovalConfig: () => KanaToolApprovalConfig;
  getApprovals: () => KanaToolApprovals;
  addTrustedShellCommand: (command: string) => void;
  getLogger: () => Logger;
};

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createServerApi(options: ServerApiOptions) {
  if (!options.token.trim()) throw new Error("KANA_SERVER_TOKEN is required.");
  const credential = Buffer.from(`Bearer ${options.token}`);
  const clients = new Set<{ send: (frame: Uint8Array) => void; close: () => void }>();
  const encoder = new TextEncoder();
  let closed = false;
  let transitioning = false;
  const { runtime } = options;
  const projection = new ServerProjection(runtime, emit);
  const approvals = new ServerApprovals({
    getSessionId: () => runtime.sessionId,
    getConfig: options.getApprovalConfig,
    getApprovals: options.getApprovals,
    addTrustedShellCommand: options.addTrustedShellCommand,
    emit,
  });
  runtime.setBeforeToolExecution(approvals.request);
  const unsubscribe = runtime.subscribe((event) => {
    if (event.type === "session_changed") approvals.resetSession();
    projection.handle(event);
  });
  const heartbeat = setInterval(() => broadcast(encoder.encode(": heartbeat\n\n")), 15_000);
  heartbeat.unref();

  function envelope(type: ServerEventType, data: unknown): ServerEvent {
    return {
      schema_version: 1,
      type,
      session_id: runtime.sessionId ?? null,
      run_id: projection.runId,
      data,
    };
  }

  function snapshot() {
    return { ...projection.snapshot(), approvals: approvals.snapshot };
  }

  function frame(event: ServerEvent): Uint8Array {
    return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  function broadcast(bytes: Uint8Array): void {
    for (const client of clients) client.send(bytes);
  }

  function emit(type: ServerEventType, data: unknown): void {
    broadcast(frame(envelope(type, data)));
  }

  function json(data: unknown, status = 200): Response {
    return Response.json(
      { schema_version: 1, data },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }

  function requireSavedSessions(): void {
    if (options.launchMode === "clean") {
      throw new ApiError(
        400,
        "unavailable",
        "Saved session operations are unavailable in clean mode.",
      );
    }
  }

  function requireSession(body: Record<string, unknown>): void {
    if (closed) throw new ApiError(503, "stopping", "Server is stopping.");
    if (body.session_id !== runtime.sessionId) {
      throw new ApiError(409, "session_mismatch", "session_id must match the active session.");
    }
    if (transitioning) throw new ApiError(409, "busy", "A session transition is active.");
  }

  async function transition<T>(operation: () => T | Promise<T>): Promise<T> {
    if (closed) throw new ApiError(503, "stopping", "Server is stopping.");
    if (transitioning || runtime.isRunning)
      throw new ApiError(409, "busy", "Stop the current run before changing sessions.");
    transitioning = true;
    try {
      return await operation();
    } finally {
      transitioning = false;
    }
  }

  function background(promise: Promise<unknown>): void {
    void promise.catch((error) => {
      options
        .getLogger()
        .error("server.submission_failed", { errorType: projectError(error).name });
    });
  }

  function events(request: Request): Response {
    let disconnect = (_closeController = true) => {};
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          let disconnected = false;
          const onAbort = () => disconnect();
          const client = {
            send(bytes: Uint8Array) {
              if (disconnected) return;
              if ((controller.desiredSize ?? 0) <= 0) {
                disconnect();
                return;
              }
              controller.enqueue(bytes);
            },
            close: () => disconnect(),
          };
          disconnect = (closeController = true) => {
            if (disconnected) return;
            disconnected = true;
            clients.delete(client);
            request.signal.removeEventListener("abort", onAbort);
            if (closeController) controller.close();
          };
          if (request.signal.aborted) {
            disconnect();
            return;
          }
          clients.add(client);
          request.signal.addEventListener("abort", onAbort, { once: true });
          client.send(frame(envelope("snapshot", snapshot())));
        },
        cancel() {
          disconnect(false);
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: 1_048_576 }),
    );
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-store",
        "X-Accel-Buffering": "no",
      },
    });
  }

  async function fetch(request: Request): Promise<Response> {
    try {
      const supplied = Buffer.from(request.headers.get("authorization") ?? "");
      if (supplied.length !== credential.length || !timingSafeEqual(supplied, credential)) {
        return Response.json(
          {
            schema_version: 1,
            error: { code: "unauthorized", message: "A valid Bearer token is required." },
          },
          {
            status: 401,
            headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" },
          },
        );
      }
      if (closed) throw new ApiError(503, "stopping", "Server is stopping.");
      const { pathname } = new URL(request.url);
      const method = request.method;
      if (method === "GET" && pathname === "/v1/state") return json(snapshot());
      if (method === "GET" && pathname === "/v1/events") return events(request);
      if (method === "GET" && pathname === "/v1/sessions") {
        return json({ current_session_id: runtime.sessionId, sessions: runtime.listSessions() });
      }
      if (method === "POST" && pathname === "/v1/sessions") {
        const session = await transition(() => runtime.startNewSession());
        return json({ session_id: session.id }, 201);
      }
      if (method === "POST" && pathname === "/v1/sessions/fork") {
        requireSavedSessions();
        const body = await readBody(request);
        requireSession(body);
        if (body.prompt !== undefined && typeof body.prompt !== "string") {
          throw new ApiError(400, "invalid_request", "prompt must be a string.");
        }
        const session = await transition(() =>
          runtime.forkSession((body.prompt as string | undefined) ?? ""),
        );
        return json({ session_id: session.id }, 201);
      }
      const resume = pathname.match(/^\/v1\/sessions\/([^/]+)\/resume$/);
      if (method === "POST" && resume) {
        requireSavedSessions();
        const id = decodeURIComponent(resume[1]!);
        if (!runtime.listSessions().some((session) => session.id === id)) {
          throw new ApiError(404, "not_found", "Saved session not found.");
        }
        const session = await transition(() => runtime.resumeSession(id));
        return json({ session_id: session.id });
      }
      const saved = pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      if (method === "DELETE" && saved) {
        requireSavedSessions();
        const deleted = await transition(() =>
          runtime.deleteSession(decodeURIComponent(saved[1]!)),
        );
        if (!deleted) throw new ApiError(404, "not_found", "Saved session not found or is active.");
        return json({ deleted: true });
      }
      if (method === "GET" && pathname === "/v1/approvals") return json(approvals.snapshot);
      if (method === "POST" && pathname === "/v1/messages") {
        const body = await readBody(request);
        const message = requiredString(body, "message");
        const delivery = body.delivery ?? "auto";
        if (delivery !== "auto" && delivery !== "queue")
          throw new ApiError(400, "invalid_request", "delivery must be auto or queue.");
        requireSession(body);
        const input = createUserMessage({ content: message, provenance: { kind: "user_input" } });
        let disposition: "submitted" | "steering" | "queued";
        if (delivery === "queue") {
          runtime.queueInput(input);
          disposition = "queued";
        } else if (runtime.canSteer) {
          background(runtime.steer(input));
          disposition = "steering";
        } else if (runtime.isRunning) {
          runtime.queueInput(input);
          disposition = "queued";
        } else {
          background(runtime.submit(input));
          disposition = "submitted";
        }
        return json({ message_id: input.id, delivery: disposition }, 202);
      }
      if (method === "POST" && pathname === "/v1/abort") {
        requireSession(await readBody(request));
        runtime.abort();
        return json({ stopping: true }, 202);
      }
      const approval = pathname.match(/^\/v1\/approvals\/([^/]+)$/);
      if (method === "POST" && approval) {
        const body = await readBody(request);
        requireSession(body);
        const decision = body.decision;
        if (
          decision !== "allow" &&
          decision !== "reject" &&
          decision !== "always" &&
          decision !== "never"
        ) {
          throw new ApiError(
            400,
            "invalid_request",
            "decision must be allow, reject, always or never.",
          );
        }
        const result = approvals.decide(
          decodeURIComponent(approval[1]!),
          decision as ApprovalDecision,
        );
        if (result === "not_found")
          throw new ApiError(404, "not_found", "Pending approval not found.");
        if (result === "invalid")
          throw new ApiError(
            400,
            "invalid_request",
            "Only shell commands can be trusted permanently.",
          );
        return json({ resolved: true });
      }
      throw new ApiError(404, "not_found", "API route not found.");
    } catch (error) {
      if (!(error instanceof ApiError)) {
        options.getLogger().error("server.request_failed", { errorType: projectError(error).name });
      }
      return Response.json(
        {
          schema_version: 1,
          error: {
            code: error instanceof ApiError ? error.code : "internal_error",
            message: error instanceof ApiError ? error.message : "Request failed.",
          },
        },
        {
          status: error instanceof ApiError ? error.status : 500,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
  }

  return {
    fetch,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      approvals.close();
      unsubscribe();
      for (const client of clients) client.close();
    },
  };
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ApiError(400, "invalid_request", "Expected a JSON object.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApiError(400, "invalid_request", "Expected a JSON object.");
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim())
    throw new ApiError(400, "invalid_request", `${field} must be a non-empty string.`);
  return value;
}
