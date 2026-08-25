import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackgroundJobManager } from "../../src/jobs";
import { createKanaAgent, KANA_BUILT_IN_TOOL_NAMES } from "../../src/kana/agent";
import { DEFAULT_KANA_CONFIG } from "../../src/kana/config";
import { createWakeScheduler } from "../../src/kana/conversation/wake-scheduler";
import {
  createMemoryConsolidationTools,
  createMemoryConsolidationTransaction,
} from "../../src/kana/memory/consolidation-tools";
import { createRememberTool } from "../../src/kana/tools/remember";
import { createScheduleWakeTool } from "../../src/kana/tools/schedule-wake";
import { createTodoWriteTool } from "../../src/kana/tools/todo-write";
import {
  createJobKillTool,
  createJobListTool,
  createJobOutputTool,
} from "../../src/tools/background-jobs";
import { createBashTool } from "../../src/tools/bash";
import { createEditTool } from "../../src/tools/edit";
import { createGlobTool } from "../../src/tools/glob";
import { createGrepTool } from "../../src/tools/grep";
import { createListTool } from "../../src/tools/list";
import { createReadTool } from "../../src/tools/read";
import type { Tool } from "../../src/tools/tool";
import { validateToolArguments } from "../../src/tools/validation";
import { createViewImageTool } from "../../src/tools/view-image";
import { createWriteTool } from "../../src/tools/write";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function createTempEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), "kana-strict-schemas-"));
  tempDirs.push(home);
  return { KANA_HOME: home };
}

function createInternalMemoryTools(): Map<string, Tool> {
  const env = createTempEnv();
  const tools = createMemoryConsolidationTools(
    { scope: "global", env },
    "full",
    createMemoryConsolidationTransaction({ scope: "global", env }),
  );
  return new Map(tools.map((tool) => [tool.name, tool]));
}

// Derive the conversation built-in tools from the real registration path
// (createKanaAgent) instead of a hand-maintained list, with every optional
// built-in enabled so a newly added tool is checked automatically.
function createAgentBuiltInTools(): Tool[] {
  const home = mkdtempSync(path.join(tmpdir(), "kana-strict-schemas-"));
  tempDirs.push(home);
  const previousHome = process.env.KANA_HOME;
  const previousKey = process.env.KANA_TEST_DEEPSEEK_KEY;
  process.env.KANA_HOME = home;
  process.env.KANA_TEST_DEEPSEEK_KEY = "secret";

  try {
    const agent = createKanaAgent(
      {
        ...DEFAULT_KANA_CONFIG,
        model: {
          ...DEFAULT_KANA_CONFIG.model,
          deepseek: {
            ...DEFAULT_KANA_CONFIG.model.deepseek,
            name: "deepseek-v4-flash-vision-exp" as const,
            apiKeyEnv: "KANA_TEST_DEEPSEEK_KEY",
          },
        },
      },
      {
        backgroundJobs,
        wakeScheduler: scheduler,
        sessionId: "session-a",
        resolveGoal: () => ({
          id: "goal-1",
          objective: "Verify schemas",
          status: "active",
          admittedRounds: 1,
          maxRounds: 8,
          startedAt: new Date("2026-08-24T00:00:00.000Z"),
        }),
        updateGoal: (change) => ({
          id: "goal-1",
          objective: "Verify schemas",
          status: change.status,
          admittedRounds: 1,
          maxRounds: 8,
          startedAt: new Date("2026-08-24T00:00:00.000Z"),
        }),
      },
    );
    return agent.state.tools;
  } finally {
    restoreEnvironment("KANA_HOME", previousHome);
    restoreEnvironment("KANA_TEST_DEEPSEEK_KEY", previousKey);
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

const scheduler = createWakeScheduler({ setTimeout: () => 1, clearTimeout: () => {} });
const backgroundJobManager = new BackgroundJobManager();
const backgroundJobs = backgroundJobManager.bind(backgroundJobManager.createOwner("session-a"), {
  maxConcurrent: 4,
});
const internalMemoryTools = createInternalMemoryTools();

type SchemaCase = {
  name: string;
  tool: Tool;
  valid: Record<string, unknown>;
  invalidArgs: Record<string, unknown>;
  unexpected: string;
};

const schemaCases: SchemaCase[] = [
  {
    name: "list",
    tool: createListTool(),
    valid: { path: "src", includeHidden: false, limit: 10 },
    invalidArgs: { cwd: "src" },
    unexpected: "cwd",
  },
  {
    name: "glob",
    tool: createGlobTool(),
    valid: { pattern: "**/*.ts", cwd: "src", type: "file" },
    invalidArgs: { pattern: "**/*.ts", path: "src" },
    unexpected: "path",
  },
  {
    name: "grep",
    tool: createGrepTool(),
    valid: { pattern: "commander", path: "src", include: "**/*.ts", literal: true },
    invalidArgs: { pattern: "foo", cwd: "src" },
    unexpected: "cwd",
  },
  {
    name: "read",
    tool: createReadTool(),
    valid: { path: "src/main.ts", offset: 2, limit: 10 },
    invalidArgs: { path: "src/main.ts", startLine: 100 },
    unexpected: "startLine",
  },
  {
    name: "view_image",
    tool: createViewImageTool(),
    valid: { path: "screenshot.png" },
    invalidArgs: { path: "screenshot.png", scale: 2 },
    unexpected: "scale",
  },
  {
    name: "write",
    tool: createWriteTool(),
    valid: { path: "a.txt", content: "hello", overwrite: false },
    invalidArgs: { path: "a.txt", content: "hello", mode: 0o644 },
    unexpected: "mode",
  },
  {
    name: "edit",
    tool: createEditTool(),
    valid: { path: "a.txt", oldText: "a", newText: "b", replaceAll: false },
    invalidArgs: { path: "a.txt", oldText: "a", newText: "b", text: "a" },
    unexpected: "text",
  },
  {
    name: "bash",
    tool: createBashTool(),
    valid: { command: "bun test", cwd: "src", timeoutMs: 1000, background: true },
    invalidArgs: { command: "bun test", path: "src" },
    unexpected: "path",
  },
  {
    name: "job_list",
    tool: createJobListTool(backgroundJobs),
    valid: {},
    invalidArgs: { sessionId: "session-a" },
    unexpected: "sessionId",
  },
  {
    name: "job_output",
    tool: createJobOutputTool(backgroundJobs),
    valid: { jobId: "job-1", waitMs: 1000 },
    invalidArgs: { jobId: "job-1", offset: 10 },
    unexpected: "offset",
  },
  {
    name: "job_kill",
    tool: createJobKillTool(backgroundJobs),
    valid: { jobId: "job-1", reason: "No longer needed." },
    invalidArgs: { jobId: "job-1", signal: "SIGKILL" },
    unexpected: "signal",
  },
  {
    name: "remember",
    tool: createRememberTool(),
    valid: { content: "x", scope: "global", title: "t", reason: "r" },
    invalidArgs: { content: "x", project: true },
    unexpected: "project",
  },
  {
    name: "schedule_wake",
    tool: createScheduleWakeTool({ scheduler, sessionId: "session-a" }),
    valid: { afterMinutes: 30, message: "continue", key: "build" },
    invalidArgs: { afterMinutes: 30, message: "continue", replaceKey: "build" },
    unexpected: "replaceKey",
  },
  {
    name: "todo_write",
    tool: createTodoWriteTool(),
    valid: { items: [{ content: "Implement it", status: "in_progress" }] },
    invalidArgs: { items: [], append: true },
    unexpected: "append",
  },
  {
    name: "read_memory",
    tool: internalMemoryTools.get("read_memory") ?? missingTool("read_memory"),
    valid: {},
    invalidArgs: { cwd: "src" },
    unexpected: "cwd",
  },
  {
    name: "edit_memory",
    tool: internalMemoryTools.get("edit_memory") ?? missingTool("edit_memory"),
    valid: { oldText: "a", newText: "b", replaceAll: false },
    invalidArgs: { oldText: "a", newText: "b", replace_all: true },
    unexpected: "replace_all",
  },
  {
    name: "replace_memory",
    tool: internalMemoryTools.get("replace_memory") ?? missingTool("replace_memory"),
    valid: { content: "x" },
    invalidArgs: { contents: "x" },
    unexpected: "contents",
  },
  {
    name: "list_daily_memory",
    tool: internalMemoryTools.get("list_daily_memory") ?? missingTool("list_daily_memory"),
    valid: { startDate: "2026-01-01", endDate: "2026-01-31" },
    invalidArgs: { from: "2026-01-01" },
    unexpected: "from",
  },
  {
    name: "read_daily_memory",
    tool: internalMemoryTools.get("read_daily_memory") ?? missingTool("read_daily_memory"),
    valid: { date: "2026-01-01" },
    invalidArgs: { date: "2026-01-01", day: "2026-01-01" },
    unexpected: "day",
  },
  {
    name: "search_daily_memory",
    tool: internalMemoryTools.get("search_daily_memory") ?? missingTool("search_daily_memory"),
    valid: { query: "x" },
    invalidArgs: { query: "x", q: "x" },
    unexpected: "q",
  },
];

function missingTool(name: string): Tool {
  throw new Error(`Expected ${name} tool.`);
}

describe("Kana-owned tool parameter schemas", () => {
  test("reject unknown arguments with the unexpected property named", () => {
    for (const schemaCase of schemaCases) {
      expect(
        () => validateToolArguments(schemaCase.tool, schemaCase.invalidArgs),
        schemaCase.name,
      ).toThrow(
        new RegExp(
          `${schemaCase.unexpected}: Unexpected property \\(not declared in the tool schema\\)`,
        ),
      );
    }
  });

  test("continue accepting every declared argument", () => {
    for (const schemaCase of schemaCases) {
      expect(validateToolArguments(schemaCase.tool, schemaCase.valid), schemaCase.name).toEqual(
        schemaCase.valid,
      );
    }
  });

  test("require additionalProperties: false on every built-in schema from the agent assembly paths", () => {
    const agentTools = createAgentBuiltInTools();
    // Guard that the derivation enabled every built-in: a missing tool here
    // would silently skip the strictness check below.
    expect(agentTools.map((tool) => tool.name)).toEqual([...KANA_BUILT_IN_TOOL_NAMES]);

    const incrementalEnv = createTempEnv();
    const fullEnv = createTempEnv();
    const consolidationTools = [
      ...createMemoryConsolidationTools(
        { scope: "global", env: incrementalEnv },
        "incremental",
        createMemoryConsolidationTransaction({ scope: "global", env: incrementalEnv }),
      ),
      ...createMemoryConsolidationTools(
        { scope: "global", env: fullEnv },
        "full",
        createMemoryConsolidationTransaction({ scope: "global", env: fullEnv }),
      ),
    ];
    expect(consolidationTools.map((tool) => tool.name)).toEqual([
      "read_memory",
      "edit_memory",
      "replace_memory",
      "read_memory",
      "list_daily_memory",
      "read_daily_memory",
      "search_daily_memory",
      "edit_memory",
      "replace_memory",
    ]);

    for (const tool of [...agentTools, ...consolidationTools]) {
      const parameters = tool.parameters as { additionalProperties?: boolean };
      expect(parameters.additionalProperties, tool.name).toBe(false);
    }
  });
});
