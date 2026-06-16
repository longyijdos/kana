import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_KANA_CONFIG,
  buildKanaSystemPrompt,
  createKanaAgent,
  formatKanaSkillsForPrompt,
  getKanaConfigPaths,
  loadKanaSkillActivations,
  loadKanaSkills,
  loadKanaSkillsFromDir,
  saveEnabledGlobalSkillNames,
} from "@/kana";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Kana skills", () => {
  test("loads a valid SKILL.md file", () => {
    const root = createTempDir();
    writeSkill(
      path.join(root, "valid-skill", "SKILL.md"),
      [
        "---",
        "name: valid-skill",
        "description: Helps with a test workflow.",
        "---",
        "Use this skill.",
        "",
      ].join("\n"),
    );

    const { skills, diagnostics } = loadKanaSkillsFromDir(root);

    expect(diagnostics).toEqual([]);
    expect(skills).toEqual([
      {
        name: "valid-skill",
        description: "Helps with a test workflow.",
        filePath: path.join(root, "valid-skill", "SKILL.md"),
        baseDir: path.join(root, "valid-skill"),
      },
    ]);
  });

  test("skips skills without descriptions", () => {
    const root = createTempDir();
    writeSkill(
      path.join(root, "missing-description", "SKILL.md"),
      ["---", "name: missing-description", "---", "No metadata.", ""].join("\n"),
    );

    const { skills, diagnostics } = loadKanaSkillsFromDir(root);

    expect(skills).toEqual([]);
    expect(diagnostics).toEqual([
      {
        type: "warning",
        code: "invalid_metadata",
        message: "description is required",
        path: path.join(root, "missing-description", "SKILL.md"),
      },
    ]);
  });

  test("warns but still loads skills with invalid names", () => {
    const root = createTempDir();
    writeSkill(
      path.join(root, "bad-name", "SKILL.md"),
      ["---", "name: Bad_Name", "description: Still useful.", "---", "Use this skill.", ""].join(
        "\n",
      ),
    );

    const { skills, diagnostics } = loadKanaSkillsFromDir(root);

    expect(skills.map((skill) => skill.name)).toEqual(["Bad_Name"]);
    expect(diagnostics).toEqual([
      {
        type: "warning",
        code: "invalid_metadata",
        message: "name contains invalid characters",
        path: path.join(root, "bad-name", "SKILL.md"),
      },
    ]);
  });

  test("loads nested skills and stops at a directory root SKILL.md", () => {
    const root = createTempDir();
    writeSkill(
      path.join(root, "nested", "child-skill", "SKILL.md"),
      ["---", "name: child-skill", "description: Child skill.", "---", "Use child.", ""].join("\n"),
    );
    writeSkill(
      path.join(root, "root-preferred", "SKILL.md"),
      ["---", "name: root-preferred", "description: Root skill.", "---", "Use root.", ""].join(
        "\n",
      ),
    );
    writeSkill(
      path.join(root, "root-preferred", "ignored", "SKILL.md"),
      ["---", "name: ignored", "description: Ignored skill.", "---", "Should not load.", ""].join(
        "\n",
      ),
    );

    const { skills } = loadKanaSkillsFromDir(root);

    expect(skills.map((skill) => skill.name)).toEqual(["child-skill", "root-preferred"]);
  });

  test("ignores markdown files that are not named SKILL.md", () => {
    const root = createTempDir();
    writeSkill(
      path.join(root, "review.md"),
      [
        "---",
        "name: review",
        "description: Should not load.",
        "---",
        "This is not a skill file.",
        "",
      ].join("\n"),
    );
    writeSkill(
      path.join(root, "valid", "SKILL.md"),
      ["---", "name: valid", "description: Should load.", "---", "Use valid.", ""].join("\n"),
    );

    const { skills, diagnostics } = loadKanaSkillsFromDir(root);

    expect(diagnostics).toEqual([]);
    expect(skills.map((skill) => skill.name)).toEqual(["valid"]);
  });

  test("rejects configured markdown files that are not SKILL.md", () => {
    const root = createTempDir();
    const skillPath = path.join(root, "review.md");
    writeSkill(
      skillPath,
      [
        "---",
        "name: review",
        "description: Should not load.",
        "---",
        "This is not a skill file.",
        "",
      ].join("\n"),
    );

    const { skills, diagnostics } = loadKanaSkills({
      includeDefaults: false,
      skillPaths: [skillPath],
    });

    expect(skills).toEqual([]);
    expect(diagnostics).toEqual([
      {
        type: "warning",
        code: "read_failed",
        message: "skill path is not a directory or SKILL.md file",
        path: skillPath,
      },
    ]);
  });

  test("keeps the first skill when names collide", () => {
    const root = createTempDir();
    writeSkill(
      path.join(root, "first", "SKILL.md"),
      ["---", "name: same-name", "description: First skill.", "---", "Use first.", ""].join("\n"),
    );
    writeSkill(
      path.join(root, "second", "SKILL.md"),
      ["---", "name: same-name", "description: Second skill.", "---", "Use second.", ""].join("\n"),
    );

    const { skills, diagnostics } = loadKanaSkills({
      includeDefaults: false,
      skillPaths: [root],
    });

    expect(skills.map((skill) => skill.filePath)).toEqual([path.join(root, "first", "SKILL.md")]);
    expect(diagnostics).toContainEqual({
      type: "collision",
      code: "name_collision",
      message: 'skill name "same-name" already loaded',
      path: path.join(root, "second", "SKILL.md"),
      winnerPath: path.join(root, "first", "SKILL.md"),
    });
  });

  test("prefers project skills over global skills with the same name", () => {
    const env = createTempEnv();
    const cwd = createTempDir();
    const { home } = getKanaConfigPaths(env);
    writeSkill(
      path.join(home, "skills", "same-name", "SKILL.md"),
      ["---", "name: same-name", "description: Global skill.", "---", "Use global.", ""].join("\n"),
    );
    writeSkill(
      path.join(cwd, ".kana", "skills", "same-name", "SKILL.md"),
      ["---", "name: same-name", "description: Project skill.", "---", "Use project.", ""].join(
        "\n",
      ),
    );

    const { skills, diagnostics } = loadKanaSkills({ cwd, env });

    expect(skills.map((skill) => skill.filePath)).toEqual([
      path.join(cwd, ".kana", "skills", "same-name", "SKILL.md"),
    ]);
    expect(diagnostics).toContainEqual({
      type: "collision",
      code: "name_collision",
      message: 'skill name "same-name" already loaded',
      path: path.join(home, "skills", "same-name", "SKILL.md"),
      winnerPath: path.join(cwd, ".kana", "skills", "same-name", "SKILL.md"),
    });
  });

  test("formats allowlisted global skills for the system prompt", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeSkillConfig(home, ["[model_invocation]", 'enabled = ["visible-skill"]', ""].join("\n"));

    const prompt = formatKanaSkillsForPrompt(
      [
        {
          name: "visible-skill",
          description: 'Handles <xml> & "quotes".',
          filePath: path.join(home, "skills", "visible-skill", "SKILL.md"),
          baseDir: path.join(home, "skills", "visible-skill"),
        },
        {
          name: "hidden-skill",
          description: "Not allowlisted.",
          filePath: path.join(home, "skills", "hidden-skill", "SKILL.md"),
          baseDir: path.join(home, "skills", "hidden-skill"),
        },
      ],
      { env },
    );

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>visible-skill</name>");
    expect(prompt).toContain("Handles &lt;xml&gt; &amp; &quot;quotes&quot;.");
    expect(prompt).toContain(
      `<location>${path.join(home, "skills", "visible-skill", "SKILL.md")}</location>`,
    );
    expect(prompt).not.toContain("hidden-skill");
  });

  test("hides global skills when the allowlist is missing", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    const prompt = formatKanaSkillsForPrompt(
      [
        {
          name: "global-skill",
          description: "Global skill.",
          filePath: path.join(home, "skills", "global-skill", "SKILL.md"),
          baseDir: path.join(home, "skills", "global-skill"),
        },
      ],
      { env },
    );

    expect(prompt).toBe("");
  });

  test("does not require project skills to be allowlisted", () => {
    const env = createTempEnv();
    const cwd = createTempDir();
    const prompt = formatKanaSkillsForPrompt(
      [
        {
          name: "project-skill",
          description: "Project-local skill.",
          filePath: path.join(cwd, ".kana", "skills", "project-skill", "SKILL.md"),
          baseDir: path.join(cwd, ".kana", "skills", "project-skill"),
        },
      ],
      { env },
    );

    expect(prompt).toContain("<name>project-skill</name>");
  });

  test("loads skill activation state for current effective skills", () => {
    const env = createTempEnv();
    const cwd = createTempDir();
    const { home } = getKanaConfigPaths(env);
    writeSkillConfig(home, ["[model_invocation]", 'enabled = ["enabled-global"]', ""].join("\n"));
    writeSkill(
      path.join(cwd, ".kana", "skills", "project-skill", "SKILL.md"),
      ["---", "name: project-skill", "description: Project skill.", "---", "Use project.", ""].join(
        "\n",
      ),
    );
    writeSkill(
      path.join(home, "skills", "enabled-global", "SKILL.md"),
      [
        "---",
        "name: enabled-global",
        "description: Enabled global.",
        "---",
        "Use global.",
        "",
      ].join("\n"),
    );
    writeSkill(
      path.join(home, "skills", "disabled-global", "SKILL.md"),
      [
        "---",
        "name: disabled-global",
        "description: Disabled global.",
        "---",
        "Use global.",
        "",
      ].join("\n"),
    );

    const { skills } = loadKanaSkillActivations({ cwd, env });

    expect(
      skills.map(({ name, scope, enabled, mutable }) => ({
        name,
        scope,
        enabled,
        mutable,
      })),
    ).toEqual([
      {
        name: "project-skill",
        scope: "project",
        enabled: true,
        mutable: false,
      },
      {
        name: "disabled-global",
        scope: "global",
        enabled: false,
        mutable: true,
      },
      {
        name: "enabled-global",
        scope: "global",
        enabled: true,
        mutable: true,
      },
    ]);
  });

  test("saves enabled global skill names", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);

    saveEnabledGlobalSkillNames(["second", "first"], { env });

    expect(readFileSync(path.join(home, "skills", "skills.toml"), "utf8")).toBe(
      ["[model_invocation]", 'enabled = ["second", "first"]', ""].join("\n"),
    );
  });

  test("builds the system prompt with available skills", () => {
    const prompt = buildKanaSystemPrompt({
      cwd: "/repo",
      skills: [
        {
          name: "test-skill",
          description: "Use for tests.",
          filePath: "/repo/.kana/skills/test-skill/SKILL.md",
          baseDir: "/repo/.kana/skills/test-skill",
        },
      ],
    });

    expect(prompt).toContain("<environment_context>");
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>test-skill</name>");
  });

  test("createKanaAgent loads skills from the default directories", () => {
    const cwd = createTempDir();
    const home = createTempDir();
    const previousCwd = process.cwd();
    const previousKanaHome = process.env.KANA_HOME;
    const previousKey = process.env.KANA_DEEPSEEK_KEY;
    process.env.KANA_HOME = path.join(home, ".kana");
    process.env.KANA_DEEPSEEK_KEY = "secret";
    writeSkill(
      path.join(cwd, ".kana", "skills", "project-skill", "SKILL.md"),
      [
        "---",
        "name: project-skill",
        "description: Project-local skill.",
        "---",
        "Use project skill.",
        "",
      ].join("\n"),
    );

    try {
      process.chdir(cwd);
      const resolvedCwd = process.cwd();
      const agent = createKanaAgent({
        ...DEFAULT_KANA_CONFIG,
        model: {
          ...DEFAULT_KANA_CONFIG.model,
          apiKeyEnv: "KANA_DEEPSEEK_KEY",
        },
      });

      expect(agent.state.system).toContain("<name>project-skill</name>");
      expect(agent.state.system).toContain(
        `<location>${path.join(
          resolvedCwd,
          ".kana",
          "skills",
          "project-skill",
          "SKILL.md",
        )}</location>`,
      );
    } finally {
      process.chdir(previousCwd);
      restoreEnv("KANA_HOME", previousKanaHome);
      restoreEnv("KANA_DEEPSEEK_KEY", previousKey);
    }
  });

  test("loads multiline descriptions", () => {
    const root = createTempDir();
    writeSkill(
      path.join(root, "manual-skill", "SKILL.md"),
      [
        "---",
        "name: manual-skill",
        "description: |",
        "  First line.",
        "  Second line.",
        "---",
        "Use manually.",
        "",
      ].join("\n"),
    );

    const { skills } = loadKanaSkillsFromDir(root);

    expect(skills[0]?.description).toBe("First line.\nSecond line.");
  });
});

function createTempEnv(): NodeJS.ProcessEnv {
  return {
    KANA_HOME: path.join(createTempDir(), ".kana"),
  };
}

function createTempDir(): string {
  const tempDir = mkdtempSync(path.join(tmpdir(), "kana-skills-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function writeSkillConfig(home: string, content: string): void {
  const filePath = path.join(home, "skills", "skills.toml");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  expect(readFileSync(filePath, "utf8")).toBe(content);
}

function writeSkill(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  expect(readFileSync(filePath, "utf8")).toBe(content);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
