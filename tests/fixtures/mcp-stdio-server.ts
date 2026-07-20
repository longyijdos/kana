import { createInterface } from "node:readline";

type RpcMessage = {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

const scenario = process.env.KANA_TEST_MCP_SCENARIO ?? "normal";
const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
let initialized = false;

process.stderr.write("fake MCP server started\n");

if (scenario === "malformed") {
  process.stdout.write("not-json\n");
} else if (scenario === "oversized") {
  process.stdout.write(`${"x".repeat(1_024)}\n`);
}

for await (const line of lines) {
  let message: RpcMessage;
  try {
    message = JSON.parse(line) as RpcMessage;
  } catch {
    process.exitCode = 2;
    break;
  }

  await handleMessage(message);
}

async function handleMessage(message: RpcMessage): Promise<void> {
  if (message.method === "initialize" && message.id !== undefined) {
    const protocolVersion = scenario === "version-mismatch" ? "2024-11-05" : "2025-11-25";
    await writeMessage(
      {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "fake-server", version: "1.0.0" },
          instructions: "Fixture instructions must not be executed.",
        },
      },
      scenario === "chunked",
    );
    return;
  }

  if (message.method === "notifications/initialized") {
    initialized = true;
    return;
  }

  if (message.method === "tools/list" && message.id !== undefined) {
    if (!initialized) {
      await writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "Client is not initialized" },
      });
      return;
    }

    const cursor = message.params?.cursor;
    await writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      result:
        cursor === undefined
          ? {
              tools: [
                {
                  name: "echo",
                  description: "Echo arguments.",
                  inputSchema: {
                    type: "object",
                    properties: { text: { type: "string" } },
                    required: ["text"],
                  },
                },
              ],
              nextCursor: "page-2",
            }
          : {
              tools: [
                {
                  name: "slow",
                  description: "Report progress.",
                  inputSchema: { type: "object" },
                },
              ],
            },
    });
    return;
  }

  if (message.method === "tools/call" && message.id !== undefined) {
    if (scenario === "exit-on-call") {
      process.exit(17);
    }
    if (scenario === "hang") {
      return;
    }

    const name = message.params?.name;
    const args = message.params?.arguments;
    const meta = asRecord(message.params?._meta);
    const progressToken = meta?.progressToken;

    if (
      name === "slow" &&
      (typeof progressToken === "string" || typeof progressToken === "number")
    ) {
      await writeRaw(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken, progress: 1, total: 2, message: "started" },
        })}\n${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken, progress: 2, total: 2, message: "finished" },
        })}\n`,
      );
    }

    const structuredContent =
      scenario === "inspect-environment"
        ? {
            cwd: process.cwd(),
            argv: process.argv.slice(2),
            env: selectEnvironment(["HOME", "PATH", "ALLOWED_SECRET", "BLOCKED_SECRET"]),
          }
        : (asRecord(args) ?? {});
    await writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: JSON.stringify(args ?? {}) }],
        structuredContent,
        isError: false,
      },
    });
    return;
  }

  if (message.method === "notifications/cancelled") {
    await writeMessage({
      jsonrpc: "2.0",
      method: "notifications/test/cancelled",
      params: { requestId: message.params?.requestId ?? "unknown" },
    });
    return;
  }

  if (message.id !== undefined && message.result === undefined && message.error === undefined) {
    await writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    });
  }
}

async function writeMessage(message: RpcMessage, chunked = false): Promise<void> {
  const encoded = `${JSON.stringify(message)}\n`;

  if (!chunked) {
    await writeRaw(encoded);
    return;
  }

  const splitAt = Math.max(1, Math.floor(encoded.length / 2));
  await writeRaw(encoded.slice(0, splitAt));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await writeRaw(encoded.slice(splitAt));
}

function writeRaw(content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(content, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function selectEnvironment(names: string[]): Record<string, string> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}
