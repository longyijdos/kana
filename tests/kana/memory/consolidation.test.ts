import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  appendKanaMemory,
  DEFAULT_KANA_CONFIG,
  getKanaConfigPaths,
  type KanaConfig,
  loadKanaMemory,
  saveKanaMemory,
} from "@/kana";
import {
  createMemoryConsolidationAgent,
  createMemoryConsolidationTransaction,
  formatFullMemoryConsolidationInput,
  formatIncrementalMemoryConsolidationInput,
  readPendingKanaMemoryBatch,
} from "../../../src/kana/memory";
import { runIncrementalMemoryConsolidation } from "../../../src/kana/memory/consolidation-agent";
import {
  createMemoryBatchReview,
  createMemoryConsolidationTools,
} from "../../../src/kana/memory/consolidation-tools";
import {
  cleanupTempKanaHomes,
  createTempKanaHomeEnv as createTempEnv,
} from "../../helpers/temp-kana-home";

afterEach(cleanupTempKanaHomes);

describe("memory consolidation agent", () => {
  test("uses only scope-bound tools for each mode", () => {
    const env = createTempEnv();
    const cwd = path.join(env.KANA_HOME, "workspace");

    expect(
      createMemoryConsolidationTools(
        { scope: "project", cwd, env },
        "incremental",
        createMemoryConsolidationTransaction({ scope: "project", cwd, env }),
        createMemoryBatchReview([]),
      ).map((tool) => tool.name),
    ).toEqual(["read_memory", "edit_memory", "replace_memory", "confirm_memory_batch"]);
    expect(
      createMemoryConsolidationTools(
        { scope: "global", env },
        "full",
        createMemoryConsolidationTransaction({ scope: "global", env }),
      ).map((tool) => tool.name),
    ).toEqual([
      "read_memory",
      "list_daily_memory",
      "read_daily_memory",
      "search_daily_memory",
      "edit_memory",
      "replace_memory",
    ]);
  });

  test("uses object-rooted parameter schemas for full consolidation tools", () => {
    const env = createTempEnv();
    const tools = createMemoryConsolidationTools(
      { scope: "global", env },
      "full",
      createMemoryConsolidationTransaction({ scope: "global", env }),
    );

    for (const tool of tools) {
      expect(tool.parameters).toMatchObject({ type: "object" });
    }
  });

  test("buffers edits until the transaction commits and preserves no file paths in results", async () => {
    const env = createTempEnv();
    saveKanaMemory("global", "Global note", { env });
    const memory = createMemoryConsolidationTransaction({ scope: "global", env });
    const tools = createMemoryConsolidationTools({ scope: "global", env }, "incremental", memory);
    const edit = tools.find((tool) => tool.name === "edit_memory");

    if (!edit) {
      throw new Error("Expected edit_memory tool.");
    }

    const output = await edit.execute(
      { oldText: "Global", newText: "Updated global" },
      { toolCallId: "call_edit", update() {} },
    );

    expect(loadKanaMemory("global", { env })).toBe("Global note\n");
    expect(memory.content).toBe("Updated global note\n");
    memory.commit();
    expect(loadKanaMemory("global", { env })).toBe("Updated global note\n");
    expect(JSON.stringify(output)).not.toContain(".kana");
  });

  test("rejects oversized pending memory before it can be committed", () => {
    const env = createTempEnv();
    writeFileSync(path.join(env.KANA_HOME ?? "", "config.toml"), "[memory]\nmax_chars = 5\n");
    const memory = createMemoryConsolidationTransaction({ scope: "global", env });

    expect(() => memory.replace("123456")).toThrow(
      "Memory content exceeds memory.max_chars: 6 / 5 characters. Compress it before saving.",
    );
    expect(memory.content).toBe("");
    memory.commit();
    expect(loadKanaMemory("global", { env })).toBe("");
  });

  test("creates an isolated agent without main-agent tools", () => {
    const env = createTempEnv();
    env.DEEPSEEK_API_KEY = "secret";
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "secret";

    try {
      const agent = createMemoryConsolidationAgent(
        {
          ...DEFAULT_KANA_CONFIG,
          memory: {
            ...DEFAULT_KANA_CONFIG.memory,
            agent: {
              ...DEFAULT_KANA_CONFIG.memory.agent,
              toolDeadlineMs: 120_000,
            },
          },
        },
        {
          scope: "project",
          mode: "full",
          env,
        },
      );
      const toolNames = agent.state.tools.map((tool) => tool.name);

      expect(agent.settings.toolDeadlineMs).toBe(120_000);
      expect(toolNames).toContain("list_daily_memory");
      expect(toolNames).not.toContain("shell");
      expect(toolNames).not.toContain("remember");
      expect(agent.state.system).toContain("memory for the current workspace only");
      expect(agent.state.system).toContain("most important and most recent information");
    } finally {
      if (previous === undefined) {
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = previous;
      }
    }
  });

  test("tells full consolidation agents about configured daily retention", () => {
    const env = createTempEnv();
    env.DEEPSEEK_API_KEY = "secret";
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "secret";

    try {
      const agent = createMemoryConsolidationAgent(
        {
          ...DEFAULT_KANA_CONFIG,
          memory: {
            ...DEFAULT_KANA_CONFIG.memory,
            dailyRetentionDays: 14,
          },
        },
        { scope: "global", mode: "full", env },
      );

      expect(agent.state.system).toContain("retains daily records for at least 14 calendar days");
      expect(agent.state.system).toContain(
        "prunes older records after this run completes successfully",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = previous;
      }
    }
  });

  test("formats incremental input from only current memory and pending entries", () => {
    const env = createTempEnv();
    saveKanaMemory("global", "Current memory", { env });
    const entry = appendKanaMemory({ scope: "global", content: "New fact", env, id: "mem_new" });

    const input = formatIncrementalMemoryConsolidationInput("global", [entry], { env });

    expect(input).toContain("Current memory");
    expect(input).toContain('<pending_daily_entries>\n[{"id":"mem_new"');
    expect(input).not.toContain(".kana");
  });

  test("requires exactly one disposition for every supplied entry", async () => {
    const env = createTempEnv();
    const first = appendKanaMemory({ env, content: "First" });
    const second = appendKanaMemory({ env, content: "Second" });
    const review = createMemoryBatchReview([first, second]);
    const context = { toolCallId: "review", update() {} };
    const confirm = async (...ids: string[]) =>
      review.tool.execute({ reviews: ids.map((id) => ({ id, disposition: "omitted" })) }, context);

    await expect(confirm(first.id)).rejects.toThrow("every supplied entry ID exactly once");
    await expect(confirm(first.id, first.id)).rejects.toThrow(
      "every supplied entry ID exactly once",
    );
    await expect(confirm(first.id, "unknown")).rejects.toThrow(
      "every supplied entry ID exactly once",
    );
    expect(review.confirmed).toBe(false);
    await confirm(second.id, first.id);
    expect(review.confirmed).toBe(true);
  });

  test("commits only a confirmed batch that ends with stop, even if the body is unchanged", async () => {
    const env = createTempEnv();
    saveKanaMemory("global", "Known fact", { env });
    const entry = appendKanaMemory({
      scope: "global",
      id: "mem_existing",
      content: "Known fact",
      env,
    });
    const requests: string[] = [];
    const responses = [
      toolCall("replace_memory", { content: "Unconfirmed edit" }),
      finish("stop"),
      toolCall("confirm_memory_batch", {
        reviews: [{ id: entry.id, disposition: "already_covered" }],
      }),
      finish("length"),
      toolCall("confirm_memory_batch", {
        reviews: [{ id: entry.id, disposition: "already_covered" }],
      }),
      finish("stop"),
    ];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push(await request.text());
        const response = responses.shift();
        if (!response) return new Response("Unexpected request", { status: 500 });
        return new Response(
          [
            ...response.map(
              (data) => `data: ${JSON.stringify({ choices: [{ index: 0, ...data }] })}`,
            ),
            "data: [DONE]",
            "",
          ].join("\n\n"),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });
    try {
      const { providersDirectory } = getKanaConfigPaths(env);
      mkdirSync(providersDirectory, { recursive: true });
      writeFileSync(
        path.join(providersDirectory, "memory-test.toml"),
        [
          `base_url = "http://127.0.0.1:${server.port}/v1"`,
          "max_retries = 0",
          "[[models]]",
          'name = "test"',
          "context_window = 32768",
          "max_output_tokens = 4096",
        ].join("\n"),
      );
      const config: KanaConfig = {
        ...DEFAULT_KANA_CONFIG,
        memory: {
          ...DEFAULT_KANA_CONFIG.memory,
          agent: {
            ...DEFAULT_KANA_CONFIG.memory.agent,
            model: { provider: "custom:memory-test", name: "test" },
          },
        },
      };
      const run = () =>
        runIncrementalMemoryConsolidation(config, {
          scope: "global",
          env,
          batch: readPendingKanaMemoryBatch("global", { env })!,
        });
      await expect(run()).rejects.toThrow("without confirming the batch");
      expect(loadKanaMemory("global", { env })).toBe("Known fact\n");
      expect(readPendingKanaMemoryBatch("global", { env })?.entries).toEqual([entry]);
      expect((await run()).outcome).toBe("length");
      expect(readPendingKanaMemoryBatch("global", { env })?.entries).toEqual([entry]);
      expect((await run()).outcome).toBe("unchanged");
      expect(loadKanaMemory("global", { env })).toBe("Known fact\n");
      expect(readPendingKanaMemoryBatch("global", { env })).toBeUndefined();
      expect(requests[0]).toContain("Entries may come from unrelated dates and conversations");
      expect(requests[0]).toContain("<pending_daily_entries>");
    } finally {
      server.stop(true);
    }
  });

  test("formats an optional user request for full consolidation", () => {
    const input = formatFullMemoryConsolidationInput("Prioritize current architecture decisions.");

    expect(input).toContain("<compaction_request>");
    expect(input).toContain("<user_request>");
    expect(input).toContain("Prioritize current architecture decisions.");
  });
});

function finish(reason: "stop" | "length" | "tool_calls") {
  return [{ delta: {}, finish_reason: reason }];
}

function toolCall(name: string, args: object) {
  return [
    {
      delta: {
        tool_calls: [
          {
            index: 0,
            id: `call_${name}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
    },
    ...finish("tool_calls"),
  ];
}
