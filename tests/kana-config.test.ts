import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildKanaSystemPrompt,
  createKanaAgent,
  DEFAULT_KANA_CONFIG,
  DEFAULT_KANA_TOOL_APPROVALS,
  formatKanaEnvironmentContext,
  getKanaConfigPaths,
  installKanaConfig,
  loadKanaConfig,
} from "@/kana";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Kana config", () => {
  test("uses ~/.kana/config.toml by default", () => {
    expect(getKanaConfigPaths({ HOME: "/home/kana" })).toEqual({
      home: "/home/kana/.kana",
      configPath: "/home/kana/.kana/config.toml",
      agentsPath: "/home/kana/.kana/AGENTS.md",
      memoryPath: "/home/kana/.kana/memory.md",
      memoryDailyPath: "/home/kana/.kana/memory",
      projectsPath: "/home/kana/.kana/projects",
      sessionsPath: "/home/kana/.kana/sessions",
      approvalsPath: "/home/kana/.kana/approvals.json",
    });
  });

  test("installs the default config without overwriting existing files", () => {
    const env = createTempEnv();
    const firstInstall = installKanaConfig(env);
    const installed = readFileSync(firstInstall.configPath, "utf8");
    const installedApprovals = JSON.parse(readFileSync(firstInstall.approvalsPath, "utf8"));

    expect(firstInstall.configStatus).toBe("created");
    expect(firstInstall.approvalsStatus).toBe("created");
    expect(installed).toContain('api_key_env = "DEEPSEEK_API_KEY"');
    expect(installed).toContain('mode = "unless_trusted"');
    expect(installed).toContain("[notification]");
    expect(installed).toContain('backend = "auto"');
    expect(installed).toContain("[memory]");
    expect(installed).toContain("enabled = true");
    expect(installed).toContain("max_chars = 6000");
    expect(installed).not.toContain("api_key =");
    expect(installedApprovals).toEqual(DEFAULT_KANA_TOOL_APPROVALS);
    expect(fileExists(getKanaConfigPaths(env).agentsPath)).toBe(false);

    writeFileSync(firstInstall.configPath, "custom = true\n");
    writeFileSync(firstInstall.approvalsPath, '{"custom":true}\n');
    const secondInstall = installKanaConfig(env);

    expect(secondInstall).toEqual({
      configPath: firstInstall.configPath,
      configStatus: "exists",
      approvalsPath: firstInstall.approvalsPath,
      approvalsStatus: "exists",
    });
    expect(readFileSync(firstInstall.configPath, "utf8")).toBe("custom = true\n");
    expect(readFileSync(firstInstall.approvalsPath, "utf8")).toBe('{"custom":true}\n');
  });

  test("force installs the default config and approvals over existing files", () => {
    const env = createTempEnv();
    const { configPath, approvalsPath } = installKanaConfig(env);
    writeFileSync(configPath, "custom = true\n");
    writeFileSync(approvalsPath, '{"custom":true}\n');

    const result = installKanaConfig(env, { force: true });

    expect(result).toEqual({
      configPath,
      configStatus: "reinstalled",
      approvalsPath,
      approvalsStatus: "reinstalled",
    });
    expect(readFileSync(configPath, "utf8")).toContain('api_key_env = "DEEPSEEK_API_KEY"');
    expect(JSON.parse(readFileSync(approvalsPath, "utf8"))).toEqual(DEFAULT_KANA_TOOL_APPROVALS);
  });

  test("loads defaults when config.toml is missing", () => {
    expect(loadKanaConfig(createTempEnv())).toEqual(DEFAULT_KANA_CONFIG);
  });

  test("merges TOML config with defaults", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(
      path.join(home, "config.toml"),
      [
        "[model]",
        'name = "deepseek-v4-flash"',
        'api_key_env = "KANA_DEEPSEEK_KEY"',
        "max_tokens = 4096",
        "",
        "[agent]",
        "max_turns = 4",
        "",
        "[approval]",
        'mode = "unless_trusted"',
        "",
        "[notification]",
        'backend = "bell"',
        "on_agent_completed = false",
        "on_approval_required = true",
        "",
        "[memory]",
        "enabled = false",
        "max_chars = 8000",
        "",
      ].join("\n"),
    );

    expect(loadKanaConfig(env)).toEqual({
      ...DEFAULT_KANA_CONFIG,
      model: {
        ...DEFAULT_KANA_CONFIG.model,
        name: "deepseek-v4-flash",
        apiKeyEnv: "KANA_DEEPSEEK_KEY",
        maxTokens: 4096,
      },
      agent: {
        maxTurns: 4,
      },
      approval: {
        mode: "unless_trusted",
      },
      notification: {
        backend: "bell",
        onAgentCompleted: false,
        onApprovalRequired: true,
      },
      memory: {
        enabled: false,
        maxChars: 8000,
      },
    });
  });

  test("rejects non-boolean memory.enabled", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), '[memory]\nenabled = "yes"\n');

    expect(() => loadKanaConfig(env)).toThrow("memory.enabled must be a boolean.");
  });

  test("rejects non-positive memory.max_chars", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), "[memory]\nmax_chars = 0\n");

    expect(() => loadKanaConfig(env)).toThrow("memory.max_chars must be a positive integer.");
  });

  test("loads the configured API key environment variable name", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), '[model]\napi_key_env = "KANA_DEEPSEEK_KEY"\n');

    expect(loadKanaConfig(env).model.apiKeyEnv).toBe("KANA_DEEPSEEK_KEY");
  });

  test("creates agents by reading the configured API key environment variable", () => {
    const previous = process.env.KANA_DEEPSEEK_KEY;
    process.env.KANA_DEEPSEEK_KEY = "secret";

    try {
      expect(() =>
        createKanaAgent({
          ...DEFAULT_KANA_CONFIG,
          model: {
            ...DEFAULT_KANA_CONFIG.model,
            apiKeyEnv: "KANA_DEEPSEEK_KEY",
          },
        }),
      ).not.toThrow();
    } finally {
      restoreEnv("KANA_DEEPSEEK_KEY", previous);
    }
  });

  test("formats environment context for the system prompt", () => {
    expect(
      formatKanaEnvironmentContext({
        cwd: "/repo",
        platform: "darwin",
        currentDate: "2026-06-12",
        timezone: "Asia/Shanghai",
      }),
    ).toBe(
      [
        "<environment_context>",
        "  <cwd>/repo</cwd>",
        "  <platform>darwin</platform>",
        "  <current_date>2026-06-12</current_date>",
        "  <timezone>Asia/Shanghai</timezone>",
        "</environment_context>",
      ].join("\n"),
    );
  });

  test("builds the system prompt with environment context", () => {
    const env = createTempEnv();
    const previousKanaHome = process.env.KANA_HOME;
    process.env.KANA_HOME = getKanaConfigPaths(env).home;

    try {
      const prompt = buildKanaSystemPrompt({
        cwd: "/repo",
        now: new Date("2026-06-11T16:30:00.000Z"),
        platform: "darwin",
        timezone: "Asia/Shanghai",
      });

      expect(prompt).toContain(
        "You are a concise coding assistant working inside the current workspace.",
      );
      expect(prompt).toContain("<cwd>/repo</cwd>");
      expect(prompt).toContain("<platform>darwin</platform>");
      expect(prompt).toContain("<current_date>2026-06-12</current_date>");
      expect(prompt).toContain("<timezone>Asia/Shanghai</timezone>");
    } finally {
      restoreEnv("KANA_HOME", previousKanaHome);
    }
  });

  test("uses ~/.kana/AGENTS.md as the system prompt when it exists", () => {
    const env = createTempEnv();
    const paths = getKanaConfigPaths(env);
    const previousKanaHome = process.env.KANA_HOME;
    const previousKey = process.env.KANA_DEEPSEEK_KEY;
    process.env.KANA_HOME = paths.home;
    process.env.KANA_DEEPSEEK_KEY = "secret";
    writeFileSync(paths.agentsPath, "Custom system prompt.\n");

    try {
      const agent = createKanaAgent({
        ...DEFAULT_KANA_CONFIG,
        model: {
          ...DEFAULT_KANA_CONFIG.model,
          apiKeyEnv: "KANA_DEEPSEEK_KEY",
        },
      });

      expect(agent.state.system).toContain(
        `<agents_instructions scope="global" path="${paths.agentsPath}">\nCustom system prompt.\n</agents_instructions>`,
      );
      expect(agent.state.system).toContain("<environment_context>");
      expect(agent.state.system).toContain(`<cwd>${process.cwd()}</cwd>`);
      expect(agent.state.system).toContain(`<platform>${process.platform}</platform>`);
    } finally {
      restoreEnv("KANA_HOME", previousKanaHome);
      restoreEnv("KANA_DEEPSEEK_KEY", previousKey);
    }
  });

  test("combines global and project AGENTS.md instructions", () => {
    const env = createTempEnv();
    const cwd = createTempDir();
    const paths = getKanaConfigPaths(env);
    const projectAgentsPath = path.join(cwd, "AGENTS.md");
    writeFileSync(paths.agentsPath, "Global instructions.\n");
    writeFileSync(projectAgentsPath, "Project instructions.\n");

    const prompt = buildKanaSystemPrompt({
      cwd,
      env,
      now: new Date("2026-06-11T16:30:00.000Z"),
      platform: "darwin",
      timezone: "Asia/Shanghai",
    });

    expect(prompt).toContain(
      `<agents_instructions scope="global" path="${paths.agentsPath}">\nGlobal instructions.\n</agents_instructions>`,
    );
    expect(prompt).toContain(
      `<agents_instructions scope="project" path="${projectAgentsPath}">\nProject instructions.\n</agents_instructions>`,
    );
    expect(prompt.indexOf("Global instructions.")).toBeLessThan(
      prompt.indexOf("Project instructions."),
    );
    expect(prompt).toContain("<environment_context>");
  });

  test("uses project AGENTS.md with the default prompt when global instructions are missing", () => {
    const env = createTempEnv();
    const cwd = createTempDir();
    const projectAgentsPath = path.join(cwd, "AGENTS.md");
    writeFileSync(projectAgentsPath, "Project-only instructions.\n");

    const prompt = buildKanaSystemPrompt({
      cwd,
      env,
      now: new Date("2026-06-11T16:30:00.000Z"),
      platform: "darwin",
      timezone: "Asia/Shanghai",
    });

    expect(prompt).toContain(
      "You are a concise coding assistant working inside the current workspace.",
    );
    expect(prompt).toContain(
      `<agents_instructions scope="project" path="${projectAgentsPath}">\nProject-only instructions.\n</agents_instructions>`,
    );
  });

  test("fails agent creation when the configured API key is missing", () => {
    const previous = process.env.KANA_DEEPSEEK_KEY;
    delete process.env.KANA_DEEPSEEK_KEY;

    try {
      expect(() =>
        createKanaAgent({
          ...DEFAULT_KANA_CONFIG,
          model: {
            ...DEFAULT_KANA_CONFIG.model,
            apiKeyEnv: "KANA_DEEPSEEK_KEY",
          },
        }),
      ).toThrow("Missing KANA_DEEPSEEK_KEY");
    } finally {
      restoreEnv("KANA_DEEPSEEK_KEY", previous);
    }
  });

  test("rejects unsupported providers", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), '[model]\nprovider = "mock"\n');

    expect(() => loadKanaConfig(env)).toThrow("Unsupported model.provider: mock");
  });

  test("rejects unsupported notification backends", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), '[notification]\nbackend = "toast"\n');

    expect(() => loadKanaConfig(env)).toThrow(
      "notification.backend must be one of: auto, off, bell, osc9, osc777, kitty.",
    );
  });
});

function createTempEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), "kana-config-"));
  tempDirs.push(home);
  mkdirSync(path.join(home, ".kana"), { recursive: true });

  return {
    HOME: home,
    ...extra,
  };
}

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kana-config-"));
  tempDirs.push(dir);
  return dir;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}
