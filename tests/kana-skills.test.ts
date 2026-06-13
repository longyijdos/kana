import {
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
  formatKanaSkillsForPrompt,
  loadKanaSkills,
  loadKanaSkillsFromDir,
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
        disableModelInvocation: false,
      },
    ]);
  });

  test("skips skills without descriptions", () => {
    const root = createTempDir();
    writeSkill(
      path.join(root, "missing-description", "SKILL.md"),
      ["---", "name: missing-description", "---", "No metadata.", ""].join(
        "\n",
      ),
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
      [
        "---",
        "name: Bad_Name",
        "description: Still useful.",
        "---",
        "Use this skill.",
        "",
      ].join("\n"),
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
      [
        "---",
        "name: child-skill",
        "description: Child skill.",
        "---",
        "Use child.",
        "",
      ].join("\n"),
    );
    writeSkill(
      path.join(root, "root-preferred", "SKILL.md"),
      [
        "---",
        "name: root-preferred",
        "description: Root skill.",
        "---",
        "Use root.",
        "",
      ].join("\n"),
    );
    writeSkill(
      path.join(root, "root-preferred", "ignored", "SKILL.md"),
      [
        "---",
        "name: ignored",
        "description: Ignored skill.",
        "---",
        "Should not load.",
        "",
      ].join("\n"),
    );

    const { skills } = loadKanaSkillsFromDir(root);

    expect(skills.map((skill) => skill.name)).toEqual([
      "child-skill",
      "root-preferred",
    ]);
  });

  test("keeps the first skill when names collide", () => {
    const root = createTempDir();
    writeSkill(
      path.join(root, "first", "SKILL.md"),
      [
        "---",
        "name: same-name",
        "description: First skill.",
        "---",
        "Use first.",
        "",
      ].join("\n"),
    );
    writeSkill(
      path.join(root, "second", "SKILL.md"),
      [
        "---",
        "name: same-name",
        "description: Second skill.",
        "---",
        "Use second.",
        "",
      ].join("\n"),
    );

    const { skills, diagnostics } = loadKanaSkills({
      includeDefaults: false,
      skillPaths: [root],
    });

    expect(skills.map((skill) => skill.filePath)).toEqual([
      path.join(root, "first", "SKILL.md"),
    ]);
    expect(diagnostics).toContainEqual({
      type: "collision",
      code: "name_collision",
      message: 'skill name "same-name" already loaded',
      path: path.join(root, "second", "SKILL.md"),
      winnerPath: path.join(root, "first", "SKILL.md"),
    });
  });

  test("formats visible skills for the system prompt", () => {
    const prompt = formatKanaSkillsForPrompt([
      {
        name: "visible-skill",
        description: 'Handles <xml> & "quotes".',
        filePath: "/tmp/visible-skill/SKILL.md",
        baseDir: "/tmp/visible-skill",
        disableModelInvocation: false,
      },
      {
        name: "manual-skill",
        description: "Only for slash command use.",
        filePath: "/tmp/manual-skill/SKILL.md",
        baseDir: "/tmp/manual-skill",
        disableModelInvocation: true,
      },
    ]);

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>visible-skill</name>");
    expect(prompt).toContain("Handles &lt;xml&gt; &amp; &quot;quotes&quot;.");
    expect(prompt).toContain("<location>/tmp/visible-skill/SKILL.md</location>");
    expect(prompt).not.toContain("manual-skill");
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
          disableModelInvocation: false,
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

  test("loads multiline descriptions and disable-model-invocation metadata", () => {
    const root = createTempDir();
    writeSkill(
      path.join(root, "manual-skill", "SKILL.md"),
      [
        "---",
        "name: manual-skill",
        "description: |",
        "  First line.",
        "  Second line.",
        "disable-model-invocation: true",
        "---",
        "Use manually.",
        "",
      ].join("\n"),
    );

    const { skills } = loadKanaSkillsFromDir(root);

    expect(skills[0]?.description).toBe("First line.\nSecond line.");
    expect(skills[0]?.disableModelInvocation).toBe(true);
  });
});

function createTempDir(): string {
  const tempDir = mkdtempSync(path.join(tmpdir(), "kana-skills-"));
  tempDirs.push(tempDir);
  return tempDir;
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
