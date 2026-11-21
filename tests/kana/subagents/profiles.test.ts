import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getKanaConfigPaths, loadKanaSubagentProfiles } from "@/kana";
import { cleanupConfigTempDirs, createTempEnv } from "../config/config-fixture";

afterEach(cleanupConfigTempDirs);

describe("Kana subagent profiles", () => {
  test("returns an empty snapshot when the agents directory does not exist", () => {
    const loaded = loadKanaSubagentProfiles({ env: createTempEnv() });

    expect(loaded).toEqual({ profiles: [], diagnostics: [] });
  });

  test("loads user role cards with tools, model preferences, and a digest", () => {
    const env = createTempEnv();
    const directory = getKanaConfigPaths(env).agentsDirectory;
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "worker.md"),
      [
        "---",
        "description: A focused custom worker",
        "tools:",
        "  - read",
        "  - github_create_issue",
        "model: custom:custom/local-worker",
        "reasoning_effort: high",
        "max_output_tokens: 4096",
        "context_limit: 32768",
        "---",
        "Follow the delegated task and return evidence.",
        "",
      ].join("\n"),
    );

    const loaded = loadKanaSubagentProfiles({ env });
    const worker = loaded.profiles.find((profile) => profile.name === "worker");

    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.profiles.map((profile) => profile.name)).toEqual(["worker"]);
    expect(worker).toMatchObject({
      name: "worker",
      description: "A focused custom worker",
      instructions: "Follow the delegated task and return evidence.",
      tools: ["read", "github_create_issue"],
      model: { provider: "custom:custom", name: "local-worker", reasoningEffort: "high" },
      maxOutputTokens: 4096,
      contextLimit: 32768,
      sourcePath: path.join(directory, "worker.md"),
    });
    expect(worker?.digest).toHaveLength(64);
  });

  test.each([
    ["max_output_tokens", "0"],
    ["max_output_tokens", "-1"],
    ["context_limit", "1.5"],
    ["context_limit", "9007199254740993"],
    ["context_limit", "unknown"],
  ])("rejects invalid budget %s: %s", (field, value) => {
    const env = createTempEnv();
    const directory = getKanaConfigPaths(env).agentsDirectory;
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "worker.md"),
      `---\ndescription: Worker\n${field}: ${value}\n---\nDo the work.\n`,
    );

    const loaded = loadKanaSubagentProfiles({ env });
    expect(loaded.profiles).toEqual([]);
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        code: "invalid_profile",
        message: expect.stringContaining(`${field} must be a positive integer`),
      }),
    ]);
  });

  test("keeps an invalid card unavailable and reports a diagnostic", () => {
    const env = createTempEnv();
    const directory = getKanaConfigPaths(env).agentsDirectory;
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "explorer.md"), "missing frontmatter\n");

    const loaded = loadKanaSubagentProfiles({ env });

    expect(loaded.profiles).toEqual([]);
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        code: "invalid_profile",
        path: path.join(directory, "explorer.md"),
      }),
    ]);
  });
});
