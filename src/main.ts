import { Type } from "@sinclair/typebox";
import { Agent, type AgentEvent } from "./agent";
import type { AssistantMessageEvent } from "./core/events";
import { getModel } from "./providers/index";
import type { Tool } from "./tools/tool";

// Manual smoke-test CLI for checking agent streaming and tool execution.
const prompt =
  Bun.argv.slice(2).join(" ") ||
  [
    "请严格按顺序使用工具完成任务：",
    "1. 用 get_number 获取 first 的值。",
    "2. 用 get_number 获取 second 的值。",
    "3. 用 add 把两个值相加。",
    "4. 用 now 获取当前 ISO 时间。",
    "最后用一句话告诉我两个数字、求和结果和时间。",
  ].join("\n");
const apiKey = process.env.DEEPSEEK_API_KEY;

if (!apiKey) {
  console.error("Missing DEEPSEEK_API_KEY.");
  console.error("Run with: DEEPSEEK_API_KEY=... bun run start \"你好\"");
  process.exit(1);
}

const addParameters = Type.Object({
  a: Type.Number(),
  b: Type.Number(),
});

const addTool = {
  name: "add",
  description: "Add two numbers and return the sum.",
  parameters: addParameters,
  execute: ({ a, b }, context) => {
    const sum = a + b;

    context.update({
      step: "computed_sum",
      sum,
    });

    return {
      content: String(sum),
      result: {
        sum,
      },
    };
  },
} satisfies Tool<typeof addParameters, { sum: number }>;

const getNumberParameters = Type.Object({
  key: Type.Union([Type.Literal("first"), Type.Literal("second")]),
});

const getNumberTool = {
  name: "get_number",
  description:
    "Return a named number. Use key=first to get 19, and key=second to get 23.",
  parameters: getNumberParameters,
  execute: ({ key }) => {
    const value = key === "first" ? 19 : 23;

    return {
      content: String(value),
      result: {
        key,
        value,
      },
    };
  },
} satisfies Tool<
  typeof getNumberParameters,
  { key: "first" | "second"; value: number }
>;

const nowParameters = Type.Object({});

const nowTool = {
  name: "now",
  description: "Return the current time as an ISO timestamp.",
  parameters: nowParameters,
  execute: () => {
    const iso = new Date().toISOString();

    return {
      content: iso,
      result: {
        iso,
      },
    };
  },
} satisfies Tool<typeof nowParameters, { iso: string }>;

const echoParameters = Type.Object({
  text: Type.String(),
});

const echoTool = {
  name: "echo",
  description: "Echo text back to the model.",
  parameters: echoParameters,
  execute: ({ text }) => ({
    content: text,
    result: {
      text,
    },
  }),
} satisfies Tool<typeof echoParameters, { text: string }>;

const model = getModel({
  provider: "deepseek",
  model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
  apiKey,
  thinking: true,
  reasoningEffort: "high",
  maxTokens: 1024,
  timeoutMs: 60_000,
  maxRetries: 1,
});

const agent = new Agent({
  model,
  system:
    [
      "You are a concise assistant.",
      "When the user asks for ordered tool work, call only the next necessary tool, then wait for the tool result before deciding the next tool.",
      "After all required tool results are available, answer the user directly.",
    ].join(" "),
  tools: [getNumberTool, addTool, nowTool, echoTool],
  maxTurns: 6,
});

try {
  console.log(`Prompt: ${prompt}`);

  const stream = agent.stream(prompt);

  for await (const event of stream) {
    printAgentEvent(event);
  }

  const messages = await stream.result();

  console.log("\nFinal messages:");
  console.log(JSON.stringify(messages, null, 2));
} catch (error) {
  console.error("\nAgent stream failed:");
  console.error(error);
  process.exitCode = 1;
}

function printAgentEvent(event: AgentEvent): void {
  switch (event.type) {
    case "agent_start":
      console.log("\n[agent_start]");
      break;
    case "agent_end":
      console.log("\n[agent_end]");
      break;
    case "turn_start":
      console.log(`\n[turn_start:${event.turn}]`);
      break;
    case "turn_end":
      console.log(
        `\n[turn_end:${event.turn} toolResults=${event.toolResults.length}]`,
      );
      break;
    case "message_start":
      console.log("\n[assistant]");
      break;
    case "message_update":
      printAssistantUpdate(event.assistantMessageEvent);
      break;
    case "message_end":
      console.log("\n[/assistant]");
      break;
    case "tool_execution_start":
      console.log(
        `\n[tool_start:${event.toolName} id=${event.toolCallId}] ${JSON.stringify(event.args)}`,
      );
      break;
    case "tool_execution_update":
      console.log(
        `\n[tool_update:${event.toolName} id=${event.toolCallId}] ${JSON.stringify(event.partialResult)}`,
      );
      break;
    case "tool_execution_end":
      console.log(
        `\n[tool_end:${event.toolName} id=${event.toolCallId} error=${event.isError}] ${JSON.stringify(event.result)}`,
      );
      break;
  }
}

function printAssistantUpdate(event: AssistantMessageEvent): void {
  switch (event.type) {
    case "thinking_start":
      process.stdout.write("\n[thinking]\n");
      break;
    case "thinking_delta":
      process.stdout.write(event.delta);
      break;
    case "thinking_end":
      process.stdout.write("\n[/thinking]\n");
      break;
    case "text_start":
      process.stdout.write("\n[answer]\n");
      break;
    case "text_delta":
      process.stdout.write(event.delta);
      break;
    case "text_end":
      process.stdout.write("\n[/answer]\n");
      break;
    case "toolcall_start":
      process.stdout.write(`\n[toolcall:${event.contentIndex}]\n`);
      break;
    case "toolcall_delta":
      process.stdout.write(event.delta);
      break;
    case "toolcall_end":
      process.stdout.write(`\n[/toolcall:${event.toolCall.name}]\n`);
      break;
    case "start":
    case "done":
    case "error":
      break;
  }
}
