import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendKanaMemory,
  createMemoryConsolidationAgent,
  DEFAULT_KANA_CONFIG,
  formatIncrementalMemoryConsolidationInput,
  loadKanaMemory,
  saveKanaMemory,
} from "@/kana";
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
      createMemoryConsolidationTools({ scope: "project", cwd, env }, "incremental").map(
        (tool) => tool.name,
      ),
    ).toEqual(["edit_memory", "replace_memory"]);
    expect(
      createMemoryConsolidationTools({ scope: "global", env }, "full").map((tool) => tool.name),
    ).toEqual([
      "list_daily_memory",
      "read_daily_memory",
      "search_daily_memory",
      "edit_memory",
      "replace_memory",
    ]);
  });

  test("writes only the fixed scope and preserves no file paths in results", async () => {
    const env = createTempEnv();
    saveKanaMemory("global", "Global note", { env });
    const tools = createMemoryConsolidationTools({ scope: "global", env }, "incremental");
    const edit = tools.find((tool) => tool.name === "edit_memory");

    if (!edit) {
      throw new Error("Expected edit_memory tool.");
    }

    const output = await edit.execute(
      { oldText: "Global", newText: "Updated global" },
      { toolCallId: "call_edit", update() {} },
    );

    expect(loadKanaMemory("global", { env })).toBe("Updated global note\n");
    expect(JSON.stringify(output)).not.toContain(".kana");
  });

  test("creates an isolated agent without main-agent tools", () => {
    const env = createTempEnv();
    const previous = process.env.KANA_DEEPSEEK_KEY;
    process.env.KANA_DEEPSEEK_KEY = "secret";

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
      expect(agent.state.system).toContain("restricted to project memory");
    } finally {
      if (previous === undefined) {
        delete process.env.KANA_DEEPSEEK_KEY;
      } else {
        process.env.KANA_DEEPSEEK_KEY = previous;
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
});

function createTempEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), "kana-consolidation-"));
  tempDirs.push(home);
  return { KANA_HOME: home };
}
