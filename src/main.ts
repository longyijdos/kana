import type { ModelContext } from "./core/context";
import { stream } from "./core/model";
import { getProvider } from "./providers/index";
import type { DeepSeekModelOptions } from "./providers/deepseek";

// Manual smoke-test CLI for checking provider streaming end to end.
const prompt = Bun.argv.slice(2).join(" ") || "用一句话介绍你自己。";
const apiKey = process.env.DEEPSEEK_API_KEY;

if (!apiKey) {
  console.error("Missing DEEPSEEK_API_KEY.");
  console.error("Run with: DEEPSEEK_API_KEY=... bun run start \"你好\"");
  process.exit(1);
}

const context: ModelContext = {
  system: "You are a concise assistant.",
  messages: [
    {
      role: "user",
      content: prompt,
    },
  ],
};

const provider = getProvider<DeepSeekModelOptions>("deepseek");

try {
  const events = stream(provider, context, {
    apiKey,
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
    thinking: true,
    reasoningEffort: "high",
    maxTokens: 128,
    timeoutMs: 60_000,
    maxRetries: 1,
  });

  console.log(`Prompt: ${prompt}`);

  for await (const event of events) {
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
        process.stdout.write("\n[\/answer]\n");
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
      case "done":
        console.log(`\nDone: ${event.reason}`);
        break;
      case "error":
        throw event.error;
      case "start":
        break;
    }
  }

  const message = await events.result();
  console.log("\nFinal message:");
  console.log(JSON.stringify(message, null, 2));
} catch (error) {
  console.error("\nStream failed:");
  console.error(error);
  process.exitCode = 1;
}
