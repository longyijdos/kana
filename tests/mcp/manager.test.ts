import { describe, expect, test } from "bun:test";
import {
  type JsonObject,
  type McpCallToolResult,
  type McpManagedClient,
  McpManager,
  type McpManagerErrorEvent,
  McpManagerStartError,
  type McpProgress,
  type McpTool,
  McpToolNameConflictError,
} from "../../src/mcp";

describe("MCP manager", () => {
  test("aggregates tools in registration order and applies remote-name filters", async () => {
    const alpha = createFakeClient({
      name: "alpha-server",
      tools: [createTool("keep"), createTool("denied"), createTool("not-included")],
    });
    const beta = createFakeClient({
      name: "beta-server",
      tools: [createTool("second")],
    });
    const manager = new McpManager({
      servers: [
        {
          id: "alpha",
          includeTools: ["keep", "denied"],
          excludeTools: ["denied"],
          createClient: () => alpha,
        },
        { id: "beta", createClient: () => beta },
      ],
    });

    const tools = await manager.start();

    expect(tools.map((tool) => tool.name)).toEqual(["alpha_keep", "beta_second"]);
    expect(manager.getToolSource("alpha_keep")).toEqual({
      serverId: "alpha",
      remoteToolName: "keep",
    });
    expect(manager.getToolSource("list")).toBeUndefined();
    expect(manager.state).toBe("ready");
    expect(manager.diagnostics).toEqual([
      {
        id: "alpha",
        required: false,
        status: "ready",
        discoveredToolCount: 3,
        toolCount: 1,
        serverInfo: { name: "alpha-server", version: "1.0.0" },
        serverCapabilities: { tools: {} },
      },
      {
        id: "beta",
        required: false,
        status: "ready",
        discoveredToolCount: 1,
        toolCount: 1,
        serverInfo: { name: "beta-server", version: "1.0.0" },
        serverCapabilities: { tools: {} },
      },
    ]);
  });

  test("isolates optional startup failures and reports diagnostics", async () => {
    const events: McpManagerErrorEvent[] = [];
    const unavailable = createFakeClient({
      name: "unavailable",
      connectError: new Error("not installed"),
    });
    const healthy = createFakeClient({ name: "healthy", tools: [createTool("search")] });
    const manager = new McpManager({
      servers: [
        { id: "unavailable", createClient: () => unavailable },
        { id: "healthy", createClient: () => healthy },
      ],
      onError: (event) => events.push(event),
    });

    const tools = await manager.start();

    expect(tools.map((tool) => tool.name)).toEqual(["healthy_search"]);
    expect(unavailable.closeCount).toBe(1);
    expect(manager.diagnostics[0]).toEqual({
      id: "unavailable",
      required: false,
      status: "failed",
      discoveredToolCount: 0,
      toolCount: 0,
      error: { name: "Error", message: "not installed" },
    });
    expect(events.map(({ serverId, phase, error }) => [serverId, phase, error.message])).toEqual([
      ["unavailable", "start", "not installed"],
    ]);
  });

  test("fails startup when a required server fails and closes every client", async () => {
    const first = createFakeClient({ name: "first", tools: [createTool("one")] });
    const required = createFakeClient({
      name: "required",
      connectError: new Error("handshake failed"),
    });
    const last = createFakeClient({ name: "last", tools: [createTool("three")] });
    const manager = new McpManager({
      servers: [
        { id: "first", createClient: () => first },
        { id: "required", required: true, createClient: () => required },
        { id: "last", createClient: () => last },
      ],
    });

    let error: unknown;
    try {
      await manager.start();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(McpManagerStartError);
    expect((error as McpManagerStartError).failures).toEqual([
      { serverId: "required", error: expect.any(Error) },
    ]);
    expect([first.closeCount, required.closeCount, last.closeCount]).toEqual([1, 1, 1]);
    expect(manager.state).toBe("closed");
    expect(manager.tools).toEqual([]);
  });

  test("rejects aliases that collide after normalization", async () => {
    const dotted = createFakeClient({ name: "dotted", tools: [createTool("read.file")] });
    const underscored = createFakeClient({
      name: "underscored",
      tools: [createTool("read_file")],
    });
    const manager = new McpManager({
      servers: [
        { id: "foo.bar", createClient: () => dotted },
        { id: "foo_bar", createClient: () => underscored },
      ],
    });

    let error: unknown;
    try {
      await manager.start();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(McpToolNameConflictError);
    expect(error).toMatchObject({
      toolName: "foo_bar_read_file",
      first: { kind: "mcp", serverId: "foo.bar", remoteToolName: "read.file" },
      second: { kind: "mcp", serverId: "foo_bar", remoteToolName: "read_file" },
    });
    expect([dotted.closeCount, underscored.closeCount]).toEqual([1, 1]);
    expect(manager.state).toBe("closed");
  });

  test("rejects MCP aliases that collide with local reserved tools", async () => {
    const client = createFakeClient({ name: "github", tools: [createTool("create.issue")] });
    const manager = new McpManager({
      servers: [{ id: "github", createClient: () => client }],
      reservedToolNames: ["github_create_issue"],
    });

    await expect(manager.start()).rejects.toBeInstanceOf(McpToolNameConflictError);
    expect(client.closeCount).toBe(1);
  });

  test("fails an optional server atomically when one tool schema is invalid", async () => {
    const invalid = createFakeClient({
      name: "invalid",
      tools: [
        createTool("valid"),
        createTool("invalid", {
          type: "object",
          properties: { value: { type: "string", pattern: "[" } },
        }),
      ],
    });
    const manager = new McpManager({
      servers: [{ id: "invalid", createClient: () => invalid }],
    });

    await expect(manager.start()).resolves.toEqual([]);
    expect(manager.diagnostics[0]).toMatchObject({
      status: "failed",
      discoveredToolCount: 2,
      toolCount: 0,
      error: { name: "McpToolSchemaError" },
    });
    expect(invalid.closeCount).toBe(1);
  });

  test("fails only the offending optional server when discovery repeats a remote name", async () => {
    const duplicate = createFakeClient({
      name: "duplicate",
      tools: [createTool("same"), createTool("same")],
    });
    const healthy = createFakeClient({ name: "healthy", tools: [createTool("unique")] });
    const manager = new McpManager({
      servers: [
        { id: "duplicate", createClient: () => duplicate },
        { id: "healthy", createClient: () => healthy },
      ],
    });

    await expect(manager.start()).resolves.toMatchObject([{ name: "healthy_unique" }]);
    expect(manager.diagnostics[0]).toMatchObject({
      status: "failed",
      error: { message: "MCP server duplicate returned duplicate tool name same." },
    });
    expect(duplicate.closeCount).toBe(1);
  });

  test("closes clients once in reverse registration order", async () => {
    const closeOrder: string[] = [];
    const errors: McpManagerErrorEvent[] = [];
    const first = createFakeClient({ name: "first", closeOrder });
    const second = createFakeClient({
      name: "second",
      closeOrder,
      closeError: new Error("close failed"),
    });
    const third = createFakeClient({ name: "third", closeOrder });
    const manager = new McpManager({
      servers: [
        { id: "first", createClient: () => first },
        { id: "second", createClient: () => second },
        { id: "third", createClient: () => third },
      ],
      onError: (event) => errors.push(event),
    });
    await manager.start();

    await Promise.all([manager.close(), manager.close()]);

    expect(closeOrder).toEqual(["third", "second", "first"]);
    expect(errors.map(({ serverId, phase, error }) => [serverId, phase, error.message])).toEqual([
      ["second", "close", "close failed"],
    ]);
    expect(manager.state).toBe("closed");
    expect(manager.diagnostics.map((diagnostic) => diagnostic.status)).toEqual([
      "closed",
      "closed",
      "closed",
    ]);
  });

  test("reports bounded startup and shutdown progress", async () => {
    const progress: Array<{
      operation: string;
      completedServerCount: number;
      totalServerCount: number;
      serverId?: string;
      outcome?: string;
    }> = [];
    const client = createFakeClient({ name: "filesystem", tools: [createTool("read_file")] });
    const manager = new McpManager({
      servers: [{ id: "filesystem", createClient: () => client }],
      onProgress: (event) => progress.push(event),
    });

    await manager.start();
    await manager.close();

    expect(progress).toEqual([
      { operation: "start", completedServerCount: 0, totalServerCount: 1 },
      {
        operation: "start",
        completedServerCount: 1,
        totalServerCount: 1,
        serverId: "filesystem",
        outcome: "ready",
      },
      { operation: "close", completedServerCount: 0, totalServerCount: 1 },
      {
        operation: "close",
        completedServerCount: 1,
        totalServerCount: 1,
        serverId: "filesystem",
        outcome: "closed",
      },
    ]);
    expect(manager.getToolSource("filesystem_read_file")).toBeUndefined();
  });

  test("waits for in-flight startup before closing", async () => {
    const gate = createDeferred<void>();
    const client = createFakeClient({ name: "slow", connectGate: gate.promise });
    const manager = new McpManager({
      servers: [{ id: "slow", createClient: () => client }],
    });

    const start = manager.start();
    const close = manager.close();
    gate.resolve();

    await start;
    await close;

    expect(client.closeCount).toBe(1);
    expect(manager.state).toBe("closed");
  });

  test("allows a synchronous failure callback to close during startup", async () => {
    let requestedClose: Promise<void> | undefined;
    let manager!: McpManager;
    manager = new McpManager({
      servers: [
        {
          id: "broken",
          createClient: () => {
            throw new Error("factory failed");
          },
        },
      ],
      onError: () => {
        requestedClose = manager.close();
      },
    });

    await manager.start();
    await requestedClose;

    expect(manager.state).toBe("closed");
  });
});

type FakeClientOptions = {
  name: string;
  tools?: McpTool[];
  connectError?: Error;
  listError?: Error;
  closeError?: Error;
  connectGate?: Promise<void>;
  closeOrder?: string[];
};

class FakeMcpClient implements McpManagedClient {
  readonly serverCapabilities = { tools: {} };
  readonly serverInfo: { name: string; version: string };
  closeCount = 0;

  constructor(private readonly options: FakeClientOptions) {
    this.serverInfo = { name: options.name, version: "1.0.0" };
  }

  async connect(): Promise<void> {
    await this.options.connectGate;
    if (this.options.connectError) {
      throw this.options.connectError;
    }
  }

  async listTools(): Promise<McpTool[]> {
    if (this.options.listError) {
      throw this.options.listError;
    }
    return this.options.tools?.slice() ?? [];
  }

  async callTool(
    name: string,
    _args?: JsonObject,
    options?: { signal?: AbortSignal; onProgress?(progress: McpProgress): void },
  ): Promise<McpCallToolResult> {
    options?.onProgress?.({ progressToken: name, progress: 1 });
    return { content: [{ type: "text", text: name }] };
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.options.closeOrder?.push(this.options.name);
    if (this.options.closeError) {
      throw this.options.closeError;
    }
  }
}

function createFakeClient(options: FakeClientOptions): FakeMcpClient {
  return new FakeMcpClient(options);
}

function createTool(name: string, inputSchema: JsonObject = { type: "object" }): McpTool {
  return { name, inputSchema };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
