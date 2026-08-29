import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { createRememberTool, getKanaMemoryPaths } from "@/kana";
import type { ToolResult } from "@/tools";
import {
  cleanupTempKanaHomes,
  createTempKanaHomeEnv as createTempEnv,
} from "../../helpers/temp-kana-home";

afterEach(cleanupTempKanaHomes);

describe("Kana remember tool", () => {
  test("describes proactive durable-memory use", () => {
    const description = createRememberTool().description;

    expect(description).toContain("Proactively save non-sensitive durable");
    expect(description).toContain("meaningful milestones");
    expect(description).toContain("Record it even when the current response already handles");
    expect(description).toContain("Default to project scope");
    expect(description).toContain("Do not save secrets");
  });

  test("records a project memory without exposing its file path", async () => {
    const env = createTempEnv();
    const cwd = path.join(env.KANA_HOME, "workspace");
    const tool = createRememberTool({ cwd, env });

    const output = await tool.execute(
      {
        content: "The project uses Bun.",
        title: "Package manager",
        reason: "Confirmed in package.json.",
      },
      createToolContext(),
    );

    expectToolResult(output);
    expect(output).toMatchObject({
      content: "Memory recorded in project scope.",
      result: {
        scope: "project",
        content: "The project uses Bun.",
        title: "Package manager",
        reason: "Confirmed in package.json.",
      },
    });
    expect(output.content).not.toContain(".kana");
    expect(readFileSync(getKanaMemoryPaths("project", { cwd, env }).dailyPath, "utf8")).toContain(
      "The project uses Bun.",
    );
  });

  test("records explicitly global memory", async () => {
    const env = createTempEnv();
    const tool = createRememberTool({ env });

    const output = await tool.execute(
      {
        scope: "global",
        content: "Use Chinese by default.",
      },
      createToolContext(),
    );

    expectToolResult(output);
    expect(output).toMatchObject({
      content: "Memory recorded in global scope.",
      result: {
        scope: "global",
        content: "Use Chinese by default.",
      },
    });
    expect(readFileSync(getKanaMemoryPaths("global", { env }).dailyPath, "utf8")).toContain(
      "Use Chinese by default.",
    );
  });
});

function createToolContext() {
  return {
    toolCallId: "call_remember",
    update() {},
  };
}

function expectToolResult(value: unknown): asserts value is ToolResult {
  expect(value).toBeObject();
  expect(value).toHaveProperty("content");
  expect(value).toHaveProperty("result");
}
