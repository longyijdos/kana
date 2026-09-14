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
        "model: custom/local-worker",
        "reasoning_effort: high",
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
      model: { provider: "custom", name: "local-worker", reasoningEffort: "high" },
      sourcePath: path.join(directory, "worker.md"),
    });
    expect(worker?.digest).toHaveLength(64);
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
