import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getKanaMemoryPaths } from "@/kana";
import type { ToolResult } from "@/tools";
import { createRememberTool } from "@/tools";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("remember tool", () => {
  test("records a project memory without exposing its file path", async () => {
    const env = createTempEnv();
    const cwd = path.join(tempDirs[0], "workspace");
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
      },
    });
    expect(readFileSync(getKanaMemoryPaths("global", { env }).dailyPath, "utf8")).toContain(
      "Use Chinese by default.",
    );
  });
});

function createTempEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), "kana-remember-tool-"));
  tempDirs.push(home);
  return { KANA_HOME: home };
}

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
