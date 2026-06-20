import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { appendKanaMemory, DEFAULT_KANA_CONFIG, loadKanaMemory, saveKanaMemory } from "@/kana";
import {
  createMemoryConsolidationAgent,
  createMemoryConsolidationTransaction,
  formatFullMemoryConsolidationInput,
  formatIncrementalMemoryConsolidationInput,
} from "../src/kana/memory";
import { createMemoryConsolidationTools } from "../src/kana/memory/consolidation-tools";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("memory consolidation agent", () => {
  test("uses only scope-bound tools for each mode", () => {
    const env = createTempEnv();
    const cwd = path.join(tempDirs[0], "workspace");

    expect(
      createMemoryConsolidationTools(
        { scope: "project", cwd, env },
        "incremental",
        createMemoryConsolidationTransaction({ scope: "project", cwd, env }),
      ).map((tool) => tool.name),
    ).toEqual(["read_memory", "edit_memory", "replace_memory"]);
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
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "secret";

    try {
      const agent = createMemoryConsolidationAgent(DEFAULT_KANA_CONFIG, {
        scope: "project",
        mode: "full",
        env,
      });
      const toolNames = agent.state.tools.map((tool) => tool.name);

      expect(toolNames).toContain("list_daily_memory");
      expect(toolNames).not.toContain("bash");
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

      expect(agent.state.system).toContain("retains daily records for 14 calendar days");
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

  test("formats incremental input from only current memory and new entries", () => {
    const env = createTempEnv();
    saveKanaMemory("global", "Current memory", { env });
    const entry = appendKanaMemory({ scope: "global", content: "New fact", env, id: "mem_new" });

    const input = formatIncrementalMemoryConsolidationInput("global", [entry], { env });

    expect(input).toContain("Current memory");
    expect(input).toContain('"id":"mem_new"');
    expect(input).not.toContain(".kana");
  });

  test("formats an optional user request for full consolidation", () => {
    const input = formatFullMemoryConsolidationInput("Prioritize current architecture decisions.");

    expect(input).toContain("<compaction_request>");
    expect(input).toContain("<user_request>");
    expect(input).toContain("Prioritize current architecture decisions.");
  });
});

function createTempEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), "kana-consolidation-"));
  tempDirs.push(home);
  return { KANA_HOME: home };
}
