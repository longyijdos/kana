import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getKanaConfigPaths, loadKanaSubagentProfiles } from "@/kana";
import { cleanupConfigTempDirs, createTempEnv } from "../config/config-fixture";

afterEach(cleanupConfigTempDirs);

describe("Kana subagent profiles", () => {
  test("loads the built-in profiles when no user directory exists", () => {
    const loaded = loadKanaSubagentProfiles({ env: createTempEnv() });

    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.profiles.map((profile) => profile.name)).toEqual([
      "explorer",
      "reviewer",
      "worker",
    ]);
    expect(loaded.profiles.every((profile) => profile.source === "builtin")).toBe(true);
    expect(loaded.profiles.every((profile) => profile.digest.length === 64)).toBe(true);
  });

  test("loads user role cards and lets a valid card shadow a built-in", () => {
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
    expect(worker).toMatchObject({
      name: "worker",
      description: "A focused custom worker",
      instructions: "Follow the delegated task and return evidence.",
      tools: ["read", "github_create_issue"],
      model: { provider: "custom", name: "local-worker", reasoningEffort: "high" },
      source: "user",
      sourcePath: path.join(directory, "worker.md"),
    });
  });

  test("keeps an invalid user override unavailable instead of falling back to the built-in", () => {
    const env = createTempEnv();
    const directory = getKanaConfigPaths(env).agentsDirectory;
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "explorer.md"), "missing frontmatter\n");

    const loaded = loadKanaSubagentProfiles({ env });

    expect(loaded.profiles.map((profile) => profile.name)).not.toContain("explorer");
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        code: "invalid_profile",
        path: path.join(directory, "explorer.md"),
      }),
    ]);
  });

  test("ignores user cards when only built-ins are requested", () => {
    const env = createTempEnv();
    const directory = getKanaConfigPaths(env).agentsDirectory;
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "custom.md"),
      "---\ndescription: Custom\ntools: [read]\n---\nCustom instructions.\n",
    );

    const loaded = loadKanaSubagentProfiles({ env, builtinsOnly: true });

    expect(loaded.profiles.map((profile) => profile.name)).toEqual([
      "explorer",
      "reviewer",
      "worker",
    ]);
    expect(loaded.diagnostics).toEqual([]);
  });
});
