import { Type } from "@sinclair/typebox";
import { Agent } from "../agent";
import { getModel } from "../providers";
import type { Tool } from "../tools/tool";

export const DEFAULT_DEMO_PROMPT = [
  "请严格按顺序使用工具完成任务：",
  "1. 用 get_number 获取 first 的值。",
  "2. 用 get_number 获取 second 的值。",
  "3. 用 add 把两个值相加。",
  "4. 用 now 获取当前 ISO 时间。",
  "最后用一句话告诉我两个数字、求和结果和时间。",
].join("\n");

const addParameters = Type.Object({
  a: Type.Number(),
  b: Type.Number(),
});

const getNumberParameters = Type.Object({
  key: Type.Union([Type.Literal("first"), Type.Literal("second")]),
});

const nowParameters = Type.Object({});

const echoParameters = Type.Object({
  text: Type.String(),
});

export function createDemoTools(): Tool[] {
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

  return [getNumberTool, addTool, nowTool, echoTool];
}

export function createDemoAgent(apiKey: string): Agent {
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

  return new Agent({
    model,
    system: [
      "You are a concise assistant.",
      "When the user asks for ordered tool work, call only the next necessary tool, then wait for the tool result before deciding the next tool.",
      "After all required tool results are available, answer the user directly.",
    ].join(" "),
    tools: createDemoTools(),
    maxTurns: 6,
  });
}
