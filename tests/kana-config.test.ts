import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_KANA_CONFIG,
  buildKanaSystemPrompt,
  createKanaAgent,
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
      sessionsPath: "/home/kana/.kana/sessions",
      approvalsPath: "/home/kana/.kana/approvals.json",
    });
  });

  test("installs the default config without overwriting existing files", () => {
    const env = createTempEnv();
    const firstInstall = installKanaConfig(env);
    const installed = readFileSync(firstInstall.configPath, "utf8");

    expect(firstInstall.status).toBe("created");
    expect(installed).toContain('api_key_env = "DEEPSEEK_API_KEY"');
    expect(installed).toContain('mode = "unless_trusted"');
    expect(installed).not.toContain("api_key =");
    expect(fileExists(getKanaConfigPaths(env).agentsPath)).toBe(false);

    writeFileSync(firstInstall.configPath, "custom = true\n");
    const secondInstall = installKanaConfig(env);

    expect(secondInstall).toEqual({
      configPath: firstInstall.configPath,
      status: "exists",
    });
    expect(readFileSync(firstInstall.configPath, "utf8")).toBe("custom = true\n");
  });

  test("force installs the default config over an existing file", () => {
    const env = createTempEnv();
    const { configPath } = installKanaConfig(env);
    writeFileSync(configPath, "custom = true\n");

    const result = installKanaConfig(env, { force: true });

    expect(result).toEqual({
      configPath,
      status: "reinstalled",
    });
    expect(readFileSync(configPath, "utf8")).toContain(
      'api_key_env = "DEEPSEEK_API_KEY"',
    );
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
    });
  });

  test("loads the configured API key environment variable name", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(
      path.join(home, "config.toml"),
      '[model]\napi_key_env = "KANA_DEEPSEEK_KEY"\n',
    );

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

      expect(agent.state.system).toContain("Custom system prompt.\n\n");
      expect(agent.state.system).toContain("<environment_context>");
      expect(agent.state.system).toContain(`<cwd>${process.cwd()}</cwd>`);
      expect(agent.state.system).toContain(`<platform>${process.platform}</platform>`);
    } finally {
      restoreEnv("KANA_HOME", previousKanaHome);
      restoreEnv("KANA_DEEPSEEK_KEY", previousKey);
    }
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
