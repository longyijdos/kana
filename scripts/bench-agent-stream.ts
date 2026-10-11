import { Agent } from "../src/agent";
import { OpenAICompatibleModel } from "../src/providers";

// Streams a long Chat Completions answer from a local SSE server through a
// real provider adapter and Agent with one subscriber, the path every
// frontend uses, and reports wall-clock time per scenario.

type Scenario = {
  name: string;
  deltas: number;
  deltaLength: number;
};

const SCENARIOS: Scenario[] = [
  { name: "short answer", deltas: 200, deltaLength: 16 },
  { name: "long answer", deltas: 4_000, deltaLength: 16 },
  { name: "very long answer", deltas: 12_000, deltaLength: 16 },
];

export async function main(): Promise<void> {
  console.log("Agent stream benchmark (OpenAI-compatible adapter, one subscriber)");
  for (const scenario of SCENARIOS) {
    const elapsedMs = await runScenario(scenario);
    const characters = scenario.deltas * scenario.deltaLength;
    console.log(
      `${scenario.name.padEnd(18)} ${String(scenario.deltas).padStart(6)} deltas  ` +
        `${String(characters).padStart(7)} chars  ${elapsedMs.toFixed(0).padStart(6)} ms`,
    );
  }
}

async function runScenario(scenario: Scenario): Promise<number> {
  const body = createSseBody(scenario);
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  });
  try {
    const agent = new Agent({
      model: new OpenAICompatibleModel({
        provider: "bench",
        model: "bench-model",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        maxRetries: 0,
        metadata: {
          contextWindow: 1_000_000,
          maxOutputTokens: 1_000_000,
          supportsParallelToolCalls: false,
          supportsHostedWebSearch: false,
          supportsImageInput: false,
        },
      }),
    });
    let observedLength = 0;
    agent.subscribe((event) => {
      if (event.type === "message_update") {
        const text = event.message.content[0];
        observedLength = text?.type === "text" ? text.text.length : observedLength;
      }
    });
    const started = performance.now();
    await agent.prompt("benchmark");
    const elapsed = performance.now() - started;
    if (observedLength !== scenario.deltas * scenario.deltaLength) {
      throw new Error(`Subscriber observed ${observedLength} characters.`);
    }
    return elapsed;
  } finally {
    await server.stop(true);
  }
}

function createSseBody(scenario: Scenario): string {
  const delta = "x".repeat(scenario.deltaLength);
  const chunk = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: delta } }] })}\n\n`;
  const finish = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  return `${chunk.repeat(scenario.deltas)}data: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`;
}

if (import.meta.main) {
  await main();
}
