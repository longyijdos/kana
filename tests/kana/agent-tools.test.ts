import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackgroundJobManager } from "@/jobs";
import {
  createKanaAgent,
  createWakeScheduler,
  DEFAULT_KANA_CONFIG,
  KANA_BUILT_IN_TOOL_NAMES,
  type KanaGoalSnapshot,
} from "@/kana";
import { createRegisteredMcpTool, type McpToolRegistry } from "@/mcp";
import { KanaSubagentManager, type KanaSubagentProfile } from "../../src/kana/subagents";
import { KanaUserTaskManager } from "../../src/kana/user-tasks";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Kana Agent tools", () => {
  test("creates all available built-ins including the MCP gateways", () => {
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

    try {
      const goal = createGoal("active");
      const agent = withKanaAgentEnvironment(() =>
        createAgentForTest(modelTestConfig(), {
          resolveMcp: () => createMcpRegistry(),
          backgroundJobs,
          wakeScheduler,
          sessionId: "session-1",
          subagents,
          subagentProfiles: [subagentProfile()],
          runSubagent: async () => ({ status: "completed", output: "", messages: [] }),
          resolveGoal: () => goal,
          updateGoal: (change) => ({ ...goal, status: change.status }),
          userTasks: new KanaUserTaskManager(),
        }),
      );

      expect(agent.state.tools.map((tool) => tool.name)).toEqual([...KANA_BUILT_IN_TOOL_NAMES]);
    } finally {
      wakeScheduler.dispose();
    }
  });

  test("enables view_image only when the active model and configuration support images", () => {
    const enabled = withKanaAgentEnvironment(() => createAgentForTest(modelTestConfig()));
    const disabledByConfig = withKanaAgentEnvironment(() =>
      createAgentForTest(modelTestConfig({ imageInput: false })),
    );
    const unsupportedModel = withKanaAgentEnvironment(() =>
      createAgentForTest(modelTestConfig({ model: "deepseek-v4-pro" })),
    );

    expect(enabled.state.tools.some((tool) => tool.name === "view_image")).toBe(true);
    expect(disabledByConfig.state.tools.some((tool) => tool.name === "view_image")).toBe(false);
    expect(unsupportedModel.state.tools.some((tool) => tool.name === "view_image")).toBe(false);
  });

  test("offers user-task delegation only with a task manager and tool selection", () => {
    const tasks = new KanaUserTaskManager();
    const config = testConfig();
    const withoutManager = withKanaAgentEnvironment(() => createAgentForTest(config));
    const enabled = withKanaAgentEnvironment(() =>
      createAgentForTest(config, { userTasks: tasks }),
    );
    const disabledByConfig = withKanaAgentEnvironment(() =>
      createAgentForTest(
        {
          ...config,
          agent: { ...config.agent, tools: ["read"] },
        },
        { userTasks: tasks },
      ),
    );

    expect(withoutManager.state.tools.some((tool) => tool.name === "delegate_user_task")).toBe(
      false,
    );
    expect(enabled.state.tools.some((tool) => tool.name === "delegate_user_task")).toBe(true);
    expect(disabledByConfig.state.tools.map((tool) => tool.name)).toEqual(["read"]);
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
      tools: ["read", "view_image", "bash", "mcp_call"],
    };
    const agent = withKanaAgentEnvironment(() =>
      createKanaAgent(
        {
          ...config.agent,
          tools: ["read", "spawn_subagent", "wait_subagent", "cancel_subagent", "mcp_call"],
        },
        {
          providers: config.provider,
          memoryEnabled: config.memory.enabled,
        },
        {
          resolveMcp: () => createMcpRegistry(),
          subagents,
          subagentProfiles: [profile],
          runSubagent: async () => ({ status: "completed", output: "", messages: [] }),
        },
      ),
    );

    expect(agent.state.tools.find((tool) => tool.name === "spawn_subagent")?.description).toContain(
      "- explorer: Explore the repository Available tools: read, mcp_call.",
    );
  });

  test("omits subagent tools while no profile is configured", () => {
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
          subagents,
          subagentProfiles: [],
          runSubagent: async () => ({ status: "completed", output: "", messages: [] }),
        },
      ),
    );

    expect(agent.state.tools.map((tool) => tool.name)).toEqual(["read"]);
  });

  test("filters MCP gateways with built-ins while keeping active update_goal available", async () => {
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
            resolveMcp: () => createMcpRegistry(),
            backgroundJobs,
            wakeScheduler,
            sessionId: "session-1",
            resolveGoal: () => goal,
            updateGoal: (change) => ({ ...goal, status: change.status }),
          },
        ),
      );

      expect(agent.state.tools.map((tool) => tool.name)).toEqual(["read", "update_goal"]);
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

  test("requires both MCP availability and global gateway selection", () => {
    for (const enabled of [true, false]) {
      for (const tools of [[], ["read"], ["read", "mcp_list_tools", "mcp_call"]] as const) {
        const config = testConfig();
        const agent = withKanaAgentEnvironment(() =>
          createAgentForTest(
            {
              ...config,
              agent: { ...config.agent, tools: [...tools] },
            },
            { resolveMcp: () => (enabled ? createMcpRegistry() : undefined) },
          ),
        );
        expect(agent.state.tools.map((tool) => tool.name)).toEqual(
          tools.filter((name) => enabled || !name.startsWith("mcp_")),
        );
      }
    }
  });

  test("keeps only core session tools and scheduled wakes in clean mode", () => {
    const wakeScheduler = createWakeScheduler();

    try {
      const agent = withKanaAgentEnvironment(() =>
        createAgentForTest(testConfig(), {
          resolveMcp: () => createMcpRegistry(),
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
        "view_image",
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
        "mcp_list_tools",
        "mcp_call",
      ],
    };
    const agent = withKanaAgentEnvironment(() =>
      createAgentForTest(testConfig(), {
        subagentProfile: profile,
        resolveMcp: () => createMcpRegistry(),
      }),
    );

    expect(agent.state.tools.map((tool) => tool.name)).toEqual([
      "read",
      "mcp_list_tools",
      "mcp_call",
    ]);
    expect(agent.state.system).toBe("Inspect only and report evidence.");
    const config = testConfig();
    const restricted = withKanaAgentEnvironment(() =>
      createAgentForTest(
        {
          ...config,
          agent: { ...config.agent, tools: ["read", "mcp_list_tools"] },
        },
        { subagentProfile: profile, resolveMcp: () => createMcpRegistry() },
      ),
    );
    expect(restricted.state.tools.map((tool) => tool.name)).toEqual(["read", "mcp_list_tools"]);
  });
});

function createMcpRegistry(): McpToolRegistry {
  const tools = ["read", "mcp_call"].map((name) =>
    createRegisteredMcpTool({
      serverId: "fixture",
      tool: { name, inputSchema: { type: "object" } },
      caller: {
        async callTool() {
          return { content: [] };
        },
      },
    }),
  );
  return {
    catalog: [{ name: "fixture", description: "Fixture MCP." }],
    listTools: (serverId) => tools.filter((tool) => tool.source.serverId === serverId),
    getTool: (serverId, name) =>
      tools.find((tool) => tool.source.serverId === serverId && tool.name === name),
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

function modelTestConfig(
  overrides: { imageInput?: boolean; model?: "deepseek-flash" | "deepseek-v4-pro" } = {},
) {
  const config = testConfig();
  return {
    ...config,
    agent: {
      ...config.agent,
      imageInput: overrides.imageInput ?? config.agent.imageInput,
      model: {
        ...config.agent.model,
        name: overrides.model ?? "deepseek-flash",
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
