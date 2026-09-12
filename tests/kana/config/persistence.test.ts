import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_KANA_CONFIG,
  DEFAULT_KANA_TOOL_APPROVALS,
  getKanaConfigPaths,
  installKanaConfig,
  loadKanaConfig,
  loadKanaSubagentProfiles,
  resetKanaConfig,
} from "@/kana";
import { cleanupConfigTempDirs, createTempEnv } from "./config-fixture";

afterEach(cleanupConfigTempDirs);

describe("Kana config persistence", () => {
  test("uses ~/.kana/config.toml by default", () => {
    expect(getKanaConfigPaths({ HOME: "/home/kana" })).toEqual({
      home: "/home/kana/.kana",
      configPath: "/home/kana/.kana/config.toml",
      configExamplePath: "/home/kana/.kana/config.example.toml",
      mcpConfigPath: "/home/kana/.kana/mcp.json",
      mcpEnabledPath: "/home/kana/.kana/mcp-enabled.json",
      agentsPath: "/home/kana/.kana/AGENTS.md",
      agentsDirectory: "/home/kana/.kana/agents",
      promptTemplatesDirectory: "/home/kana/.kana/prompts",
      promptTemplateExamplePath: "/home/kana/.kana/prompts/template.md.example",
      memoryDirectory: "/home/kana/.kana/memory",
      sessionsPath: "/home/kana/.kana/sessions",
      artifactsPath: "/home/kana/.kana/artifacts",
      logsPath: "/home/kana/.kana/logs",
      accountingPath: "/home/kana/.kana/accounting",
      approvalsPath: "/home/kana/.kana/approvals.json",
      themesDirectory: "/home/kana/.kana/themes",
      skillsConfigPath: "/home/kana/.kana/skills/skills.toml",
      providersDirectory: "/home/kana/.kana/providers",
      customProviderPath: "/home/kana/.kana/providers/custom.toml",
      customProviderExamplePath: "/home/kana/.kana/providers/custom.example.toml",
      subagentProfileExamplePath: "/home/kana/.kana/agents/profile.md.example",
    });
  });

  test("installs state files without materializing the default config", () => {
    const env = createTempEnv();
    const firstInstall = installKanaConfig(env);
    const installedMcpConfig = JSON.parse(readFileSync(firstInstall.mcpConfigPath, "utf8"));
    const installedMcpEnabled = JSON.parse(readFileSync(firstInstall.mcpEnabledPath, "utf8"));
    const installedApprovals = JSON.parse(readFileSync(firstInstall.approvalsPath, "utf8"));
    const installedSkillsConfig = readFileSync(firstInstall.skillsConfigPath, "utf8");
    const installedConfigExample = readFileSync(firstInstall.configExamplePath, "utf8");
    const installedCustomProviderExample = readFileSync(
      firstInstall.customProviderExamplePath,
      "utf8",
    );
    const installedSubagentProfileExample = readFileSync(
      firstInstall.subagentProfileExamplePath,
      "utf8",
    );
    const installedPromptTemplateExample = readFileSync(
      firstInstall.promptTemplateExamplePath,
      "utf8",
    );

    expect(firstInstall.configStatus).toBe("defaults");
    expect(firstInstall.configExampleStatus).toBe("created");
    expect(firstInstall.mcpConfigStatus).toBe("created");
    expect(firstInstall.mcpEnabledStatus).toBe("created");
    expect(firstInstall.approvalsStatus).toBe("created");
    expect(firstInstall.skillsConfigStatus).toBe("created");
    expect(firstInstall.subagentProfileExampleStatus).toBe("created");
    expect(firstInstall.promptTemplateExampleStatus).toBe("created");
    expect(firstInstall.customProviderExampleStatus).toBe("created");
    expect(existsSync(firstInstall.configPath)).toBe(false);
    expect(installedConfigExample).toContain("[provider.deepseek]");
    expect(installedConfigExample).toContain("[provider.openai-codex]");
    expect(installedConfigExample).toContain("[agent.model]");
    expect(installedConfigExample).toContain('tools = ["list","glob","grep","read"');
    expect(installedConfigExample).toContain("[memory.agent.model]");
    expect(installedConfigExample).toContain("web_search = true");
    expect(installedConfigExample).toContain("image_input = true");
    expect(installedConfigExample).toContain("goal_max_rounds = 8");
    expect(installedConfigExample).toContain("tool_deadline_ms = 660000");
    expect(installedConfigExample).toContain("parallel_tool_calls = true");
    expect(installedConfigExample).toContain("max_parallel_tool_calls = 4");
    expect(installedConfigExample).toContain("tool_result_artifacts = true");
    expect(installedConfigExample).toContain("[agent.background_jobs]");
    expect(installedConfigExample).toContain("[agent.repeated_tool_calls]");
    expect(installedConfigExample).toContain("reminder_thresholds = [3,5,8]");
    expect(installedConfigExample).toContain("excluded_tools = []");
    expect(installedConfigExample).toContain('theme = "kana-dark"');
    expect(installedConfigExample).toContain("hyperlinks = true");
    expect(installedConfigExample).toContain("render_latex = true");
    expect(installedConfigExample).toContain("render_mermaid = true");
    expect(installedConfigExample).toContain("smooth_text_streaming = true");
    expect(installedConfigExample).toContain("collapse_long_pastes = true");
    expect(installedConfigExample).toContain("Kana does not read this file.");
    expect(installedConfigExample).toContain('provider = "deepseek"');
    expect(installedConfigExample).toContain("# max_output_tokens = 128000");
    expect(installedCustomProviderExample).toContain('base_url = "https://api.example.com/v1"');
    expect(installedCustomProviderExample).toContain("[[models]]");
    expect(installedSubagentProfileExample).toContain("description: Review database migrations");
    expect(installedPromptTemplateExample).toContain(":squash-cleanup");
    expect(installedPromptTemplateExample).toContain("{{base=main}}");
    expect(installedSubagentProfileExample).toContain("# model: openai-codex/gpt-5.6-terra");
    expect(loadKanaSubagentProfiles({ env }).profiles.map((profile) => profile.name)).toEqual([
      "explorer",
      "reviewer",
      "worker",
    ]);
    expect(installedMcpConfig).toEqual({ mcpServers: {} });
    expect(installedMcpEnabled).toEqual({ enabledServers: [] });
    expect(statSync(firstInstall.mcpEnabledPath).mode & 0o777).toBe(0o600);
    expect(installedApprovals).toEqual(DEFAULT_KANA_TOOL_APPROVALS);
    expect(installedSkillsConfig).toBe(["[model_invocation]", "enabled = []", ""].join("\n"));
    expect(existsSync(getKanaConfigPaths(env).agentsPath)).toBe(false);

    writeFileSync(firstInstall.configPath, "custom = true\n");
    writeFileSync(firstInstall.mcpConfigPath, '{"custom":true}\n');
    writeFileSync(firstInstall.mcpEnabledPath, '{"enabledServers":["custom"]}\n');
    writeFileSync(firstInstall.approvalsPath, '{"custom":true}\n');
    writeFileSync(firstInstall.skillsConfigPath, "custom = true\n");
    const userProfilePath = path.join(
      getKanaConfigPaths(env).agentsDirectory,
      "database-reviewer.md",
    );
    writeFileSync(userProfilePath, "user profile\n");
    const secondInstall = installKanaConfig(env);

    expect(secondInstall).toEqual({
      configPath: firstInstall.configPath,
      configStatus: "exists",
      configExamplePath: firstInstall.configExamplePath,
      configExampleStatus: "exists",
      mcpConfigPath: firstInstall.mcpConfigPath,
      mcpConfigStatus: "exists",
      mcpEnabledPath: firstInstall.mcpEnabledPath,
      mcpEnabledStatus: "exists",
      approvalsPath: firstInstall.approvalsPath,
      approvalsStatus: "exists",
      skillsConfigPath: firstInstall.skillsConfigPath,
      skillsConfigStatus: "exists",
      subagentProfileExamplePath: firstInstall.subagentProfileExamplePath,
      subagentProfileExampleStatus: "exists",
      promptTemplateExamplePath: firstInstall.promptTemplateExamplePath,
      promptTemplateExampleStatus: "exists",
      customProviderExamplePath: firstInstall.customProviderExamplePath,
      customProviderExampleStatus: "exists",
    });
    expect(readFileSync(firstInstall.configPath, "utf8")).toBe("custom = true\n");
    expect(readFileSync(firstInstall.mcpConfigPath, "utf8")).toBe('{"custom":true}\n');
    expect(readFileSync(firstInstall.mcpEnabledPath, "utf8")).toBe(
      '{"enabledServers":["custom"]}\n',
    );
    expect(readFileSync(firstInstall.approvalsPath, "utf8")).toBe('{"custom":true}\n');
    expect(readFileSync(firstInstall.skillsConfigPath, "utf8")).toBe("custom = true\n");
    expect(readFileSync(userProfilePath, "utf8")).toBe("user profile\n");
  });

  test("resets only configuration state and preserves credentials and user data", () => {
    const env = createTempEnv();
    installKanaConfig(env);
    const paths = getKanaConfigPaths(env);
    writeFileSync(paths.configPath, "custom = true\n");
    writeFileSync(paths.configExamplePath, "stale template\n");
    writeFileSync(paths.mcpConfigPath, '{"custom":true}\n');
    writeFileSync(paths.mcpEnabledPath, '{"enabledServers":["custom"]}\n');
    writeFileSync(paths.approvalsPath, '{"custom":true}\n');
    writeFileSync(paths.skillsConfigPath, "custom = true\n");

    const preservedFiles = new Map([
      [path.join(paths.home, "oauth-tokens.json"), "oauth"],
      [paths.agentsPath, "global instructions"],
      [path.join(paths.sessionsPath, "session.jsonl"), "session"],
      [path.join(paths.memoryDirectory, "memory.md"), "memory"],
      [path.join(paths.accountingPath, "usage.jsonl"), "accounting"],
      [path.join(paths.logsPath, "session.jsonl"), "logs"],
      [path.join(paths.themesDirectory, "ocean.json"), "theme"],
      [path.join(paths.agentsDirectory, "database-reviewer.md"), "user profile"],
      [paths.subagentProfileExamplePath, readFileSync(paths.subagentProfileExamplePath, "utf8")],
      [paths.promptTemplateExamplePath, readFileSync(paths.promptTemplateExamplePath, "utf8")],
      [path.join(paths.home, "skills", "kana-skills", "SKILL.md"), "default repository"],
      [path.join(paths.home, "skills", "personal", "SKILL.md"), "personal skill"],
    ]);
    for (const [filePath, content] of preservedFiles) {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
    }

    const result = resetKanaConfig(env);

    expect(result).toEqual({
      configPath: paths.configPath,
      configRemoved: true,
      configExamplePath: paths.configExamplePath,
      mcpConfigPath: paths.mcpConfigPath,
      mcpEnabledPath: paths.mcpEnabledPath,
      approvalsPath: paths.approvalsPath,
      skillsConfigPath: paths.skillsConfigPath,
    });
    expect(existsSync(paths.configPath)).toBe(false);
    expect(readFileSync(paths.configExamplePath, "utf8")).not.toBe("stale template\n");
    expect(readFileSync(paths.configExamplePath, "utf8")).toContain("[provider.openai-codex]");
    expect(JSON.parse(readFileSync(paths.mcpConfigPath, "utf8"))).toEqual({ mcpServers: {} });
    expect(JSON.parse(readFileSync(paths.mcpEnabledPath, "utf8"))).toEqual({
      enabledServers: [],
    });
    expect(JSON.parse(readFileSync(paths.approvalsPath, "utf8"))).toEqual(
      DEFAULT_KANA_TOOL_APPROVALS,
    );
    expect(readFileSync(paths.skillsConfigPath, "utf8")).toBe(
      ["[model_invocation]", "enabled = []", ""].join("\n"),
    );
    for (const [filePath, content] of preservedFiles) {
      expect(readFileSync(filePath, "utf8")).toBe(content);
    }
    expect(resetKanaConfig(env).configRemoved).toBe(false);
  });

  test("refreshes generated examples without creating config.toml", () => {
    const env = createTempEnv();
    const firstInstall = installKanaConfig(env);
    writeFileSync(firstInstall.configExamplePath, "custom example\n");
    writeFileSync(firstInstall.subagentProfileExamplePath, "stale profile example\n");
    writeFileSync(firstInstall.promptTemplateExamplePath, "stale prompt example\n");

    const secondInstall = installKanaConfig(env);

    expect(secondInstall.configStatus).toBe("defaults");
    expect(secondInstall.configExampleStatus).toBe("updated");
    expect(secondInstall.subagentProfileExampleStatus).toBe("updated");
    expect(secondInstall.promptTemplateExampleStatus).toBe("updated");
    expect(existsSync(secondInstall.configPath)).toBe(false);
    expect(readFileSync(secondInstall.configExamplePath, "utf8")).toContain(
      "[provider.openai-codex]",
    );
    expect(readFileSync(secondInstall.subagentProfileExamplePath, "utf8")).toContain(
      "description: Review database migrations",
    );
    expect(readFileSync(secondInstall.promptTemplateExamplePath, "utf8")).toContain(
      "{{branch=the merged branch}}",
    );
  });

  test("loads defaults when config.toml is missing", () => {
    expect(loadKanaConfig(createTempEnv())).toEqual(DEFAULT_KANA_CONFIG);
  });
});
