import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import {
  createKanaAgent,
  createWakeScheduler,
  DEFAULT_KANA_CONFIG,
  KANA_BUILT_IN_TOOL_NAMES,
} from "@/kana";
import type { Tool } from "@/tools";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Kana Agent tools", () => {
  test("adds external tools after the complete built-in namespace", () => {
    const wakeScheduler = createWakeScheduler();
    const externalTool = createTool("github_create_issue");

    try {
      const agent = withKanaAgentEnvironment(() =>
        createKanaAgent(visionTestConfig(), {
          additionalTools: [externalTool],
          wakeScheduler,
          sessionId: "session-1",
        }),
      );

      expect(agent.state.tools.map((tool) => tool.name)).toEqual([
        ...KANA_BUILT_IN_TOOL_NAMES,
        "github_create_issue",
      ]);
    } finally {
      wakeScheduler.dispose();
    }
  });

  test("enables view_image only when the active model and configuration support images", () => {
    const enabled = withKanaAgentEnvironment(() => createKanaAgent(visionTestConfig()));
    const disabledByConfig = withKanaAgentEnvironment(() =>
      createKanaAgent(visionTestConfig({ imageInput: false })),
    );
    const unsupportedModel = withKanaAgentEnvironment(() => createKanaAgent(testConfig()));

    expect(enabled.state.tools.some((tool) => tool.name === "view_image")).toBe(true);
    expect(disabledByConfig.state.tools.some((tool) => tool.name === "view_image")).toBe(false);
    expect(unsupportedModel.state.tools.some((tool) => tool.name === "view_image")).toBe(false);
  });

  test("rejects external tool names that collide with built-in tools", () => {
    expect(() =>
      withKanaAgentEnvironment(() =>
        createKanaAgent(testConfig(), {
          additionalTools: [createTool("read")],
        }),
      ),
    ).toThrow("Duplicate Kana Agent tool name: read.");
  });

  test("keeps only core tools and scheduled wakes in clean mode", () => {
    const wakeScheduler = createWakeScheduler();

    try {
      const agent = withKanaAgentEnvironment(() =>
        createKanaAgent(testConfig(), {
          additionalTools: [createTool("github_create_issue")],
          launchMode: "clean",
          wakeScheduler,
          sessionId: "session-1",
        }),
      );

      expect(agent.state.tools.map((tool) => tool.name)).toEqual([
        "list",
        "glob",
        "grep",
        "read",
        "write",
        "edit",
        "bash",
        "schedule_wake",
      ]);
    } finally {
      wakeScheduler.dispose();
    }
  });
});

function createTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    parameters: Type.Object({}),
    execute: () => ({ content: "ok", result: {} }),
  };
}

function testConfig() {
  return {
    ...DEFAULT_KANA_CONFIG,
    model: {
      ...DEFAULT_KANA_CONFIG.model,
      deepseek: {
        ...DEFAULT_KANA_CONFIG.model.deepseek,
        apiKeyEnv: "KANA_TEST_DEEPSEEK_KEY",
      },
    },
  };
}

function visionTestConfig(overrides: { imageInput?: boolean } = {}) {
  const config = testConfig();
  return {
    ...config,
    model: {
      ...config.model,
      deepseek: {
        ...config.model.deepseek,
        name: "deepseek-v4-flash-vision-exp" as const,
        ...overrides,
      },
    },
  };
}

function withKanaAgentEnvironment<T>(run: () => T): T {
  const home = mkdtempSync(path.join(tmpdir(), "kana-agent-tools-"));
  tempDirs.push(home);
  const previousHome = process.env.KANA_HOME;
  const previousKey = process.env.KANA_TEST_DEEPSEEK_KEY;
  process.env.KANA_HOME = home;
  process.env.KANA_TEST_DEEPSEEK_KEY = "secret";

  try {
    return run();
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
