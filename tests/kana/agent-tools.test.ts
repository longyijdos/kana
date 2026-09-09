import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { BackgroundJobManager } from "@/jobs";
import {
  createKanaAgent,
  createWakeScheduler,
  DEFAULT_KANA_CONFIG,
  KANA_BUILT_IN_TOOL_NAMES,
  type KanaGoalSnapshot,
} from "@/kana";
import type { Tool } from "@/tools";
import { KanaSubagentManager, type KanaSubagentProfile } from "../../src/kana/subagents";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Kana Agent tools", () => {
  test("adds external tools after the complete built-in namespace", () => {
    const wakeScheduler = createWakeScheduler();
    const backgroundJobManager = new BackgroundJobManager();
    const backgroundJobs = backgroundJobManager.bind(
      backgroundJobManager.createOwner("session-1"),
      { maxConcurrent: 4 },
    );
    const subagentManager = new KanaSubagentManager();
    const subagents = subagentManager.bind(
      subagentManager.createOwner({
        sessionId: "session-1",
        cwd: process.cwd(),
        persistent: false,
      }),
      { maxLive: 4 },
    );
    const externalTool = createTool("github_create_issue");

    try {
      const goal = createGoal("active");
      const agent = withKanaAgentEnvironment(() =>
        createAgentForTest(visionTestConfig(), {
          additionalTools: [externalTool],
          backgroundJobs,
          wakeScheduler,
          sessionId: "session-1",
          subagents,
          resolveSubagentProfiles: () => [subagentProfile()],
          runSubagent: async () => ({ status: "completed", output: "", messages: [] }),
          resolveGoal: () => goal,
          updateGoal: (change) => ({ ...goal, status: change.status }),
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
    const enabled = withKanaAgentEnvironment(() => createAgentForTest(visionTestConfig()));
    const disabledByConfig = withKanaAgentEnvironment(() =>
      createAgentForTest(visionTestConfig({ imageInput: false })),
    );
    const unsupportedModel = withKanaAgentEnvironment(() => createAgentForTest(testConfig()));

    expect(enabled.state.tools.some((tool) => tool.name === "view_image")).toBe(true);
    expect(disabledByConfig.state.tools.some((tool) => tool.name === "view_image")).toBe(false);
    expect(unsupportedModel.state.tools.some((tool) => tool.name === "view_image")).toBe(false);
  });

  test("advertises each subagent profile's effective tools", () => {
    const config = testConfig();
    const subagentManager = new KanaSubagentManager();
    const subagents = subagentManager.bind(
      subagentManager.createOwner({
        sessionId: "session-1",
        cwd: process.cwd(),
        persistent: false,
      }),
      { maxLive: 4 },
    );
    const profile: KanaSubagentProfile = {
      ...subagentProfile(),
      tools: ["read", "view_image", "bash", "github_create_issue"],
    };
    const agent = withKanaAgentEnvironment(() =>
      createKanaAgent(
        {
          ...config.agent,
          tools: ["read", "spawn_subagent", "wait_subagent", "cancel_subagent"],
        },
        {
          providers: config.provider,
          memoryEnabled: config.memory.enabled,
        },
        {
          additionalTools: [createTool("github_create_issue")],
          subagents,
          resolveSubagentProfiles: () => [profile],
          runSubagent: async () => ({ status: "completed", output: "", messages: [] }),
        },
      ),
    );

    expect(agent.state.tools.find((tool) => tool.name === "spawn_subagent")?.description).toContain(
      "- explorer: Explore the repository Available tools: read, github_create_issue.",
    );
  });

  test("filters configurable built-in tools without affecting external tools or update_goal", async () => {
    const goal = createGoal("active");
    const config = testConfig();
    const wakeScheduler = createWakeScheduler();
    const backgroundJobManager = new BackgroundJobManager();
    const backgroundJobs = backgroundJobManager.bind(
      backgroundJobManager.createOwner("session-1"),
      { maxConcurrent: 4 },
    );
    try {
      const agent = withKanaAgentEnvironment(() =>
        createKanaAgent(
          {
            ...config.agent,
            tools: ["read"],
          },
          {
            providers: config.provider,
            memoryEnabled: config.memory.enabled,
          },
          {
            additionalTools: [createTool("github_create_issue")],
            backgroundJobs,
            wakeScheduler,
            sessionId: "session-1",
            resolveGoal: () => goal,
            updateGoal: (change) => ({ ...goal, status: change.status }),
          },
        ),
      );

      expect(agent.state.tools.map((tool) => tool.name)).toEqual([
        "read",
        "update_goal",
        "github_create_issue",
      ]);
    } finally {
      wakeScheduler.dispose();
      await backgroundJobManager.close();
    }
  });

  test("advertises update_goal only while a goal is active", () => {
    const activeGoal = createGoal("active");
    const completedGoal = createGoal("completed");
    const active = withKanaAgentEnvironment(() =>
      createAgentForTest(testConfig(), {
        resolveGoal: () => activeGoal,
        updateGoal: (change) => ({ ...activeGoal, status: change.status }),
      }),
    );
    const completed = withKanaAgentEnvironment(() =>
      createAgentForTest(testConfig(), {
        resolveGoal: () => completedGoal,
        updateGoal: (change) => ({ ...completedGoal, status: change.status }),
      }),
    );

    expect(active.state.tools.map((tool) => tool.name)).toContain("update_goal");
    expect(completed.state.tools.map((tool) => tool.name)).not.toContain("update_goal");
  });

  test("rejects external tool names that collide with built-in tools", () => {
    const config = testConfig();
    expect(() =>
      withKanaAgentEnvironment(() =>
        createKanaAgent(
          { ...config.agent, tools: [] },
          { providers: config.provider, memoryEnabled: config.memory.enabled },
          { additionalTools: [createTool("read")] },
        ),
      ),
    ).toThrow("Duplicate Kana Agent tool name: read.");
  });

  test("keeps only core session tools and scheduled wakes in clean mode", () => {
    const wakeScheduler = createWakeScheduler();

    try {
      const agent = withKanaAgentEnvironment(() =>
        createAgentForTest(testConfig(), {
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
        "todo_write",
        "schedule_wake",
      ]);
      expect(agent.state.tools.some((tool) => tool.name === "job_start")).toBe(false);
    } finally {
      wakeScheduler.dispose();
    }
  });

  test("restricts a child to its role-card tools and excludes orchestration tools", () => {
    const profile: KanaSubagentProfile = {
      ...subagentProfile(),
      instructions: "Inspect only and report evidence.",
      tools: [
        "read",
        "job_start",
        "todo_write",
        "remember",
        "schedule_wake",
        "spawn_subagent",
        "github_create_issue",
      ],
    };
    const agent = withKanaAgentEnvironment(() =>
      createAgentForTest(testConfig(), {
        subagentProfile: profile,
        additionalTools: [createTool("github_create_issue"), createTool("slack_send")],
      }),
    );

    expect(agent.state.tools.map((tool) => tool.name)).toEqual(["read", "github_create_issue"]);
    expect(agent.state.system).toBe("Inspect only and report evidence.");
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

function createGoal(status: KanaGoalSnapshot["status"]): KanaGoalSnapshot {
  return {
    id: "goal-1",
    objective: "Finish the feature",
    status,
    admittedRounds: 1,
    maxRounds: 8,
    startedAt: new Date("2026-08-24T00:00:00.000Z"),
  };
}

function subagentProfile(): KanaSubagentProfile {
  return {
    name: "explorer",
    description: "Explore the repository",
    instructions: "Inspect only.",
    tools: ["read"],
    source: "builtin",
    digest: "profile-digest",
  };
}

function testConfig() {
  return {
    ...DEFAULT_KANA_CONFIG,
    provider: {
      ...DEFAULT_KANA_CONFIG.provider,
      deepseek: {
        ...DEFAULT_KANA_CONFIG.provider.deepseek,
        apiKeyEnv: "KANA_TEST_DEEPSEEK_KEY",
      },
    },
  };
}

function visionTestConfig(overrides: { imageInput?: boolean } = {}) {
  const config = testConfig();
  return {
    ...config,
    agent: {
      ...config.agent,
      imageInput: overrides.imageInput ?? config.agent.imageInput,
      model: {
        ...config.agent.model,
        name: "deepseek-v4-flash-vision-exp" as const,
      },
    },
  };
}

function createAgentForTest(
  config: ReturnType<typeof testConfig>,
  options: Parameters<typeof createKanaAgent>[2] = {},
) {
  return createKanaAgent(
    config.agent,
    {
      providers: config.provider,
      memoryEnabled: config.memory.enabled,
    },
    options,
  );
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
