import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resyncKanaSkills, syncKanaSkills } from "@/kana";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Kana skill sync", () => {
  test("copies installed top-level skills to the Codex skills directory", () => {
    const env = createTempEnv();
    writeKanaSkill(env, "web-search", "Search the web.");
    const fetchPath = writeKanaSkill(env, "web-fetch", "Fetch a page.");
    writeFile(path.join(fetchPath, "templates", "extract.md"), "template");

    const result = syncKanaSkills(env, {
      targetAgent: "codex",
    });

    expect(result).toEqual({
      sourcePath: path.join(env.KANA_HOME, "skills", "kana-skills"),
      targetName: "codex",
      targetPath: path.join(env.HOME, ".codex", "skills"),
      skills: [
        {
          name: "web-fetch",
          sourcePath: path.join(env.KANA_HOME, "skills", "kana-skills", "web-fetch"),
          status: "copied",
          targetPath: path.join(env.HOME, ".codex", "skills", "web-fetch"),
        },
        {
          name: "web-search",
          sourcePath: path.join(env.KANA_HOME, "skills", "kana-skills", "web-search"),
          status: "copied",
          targetPath: path.join(env.HOME, ".codex", "skills", "web-search"),
        },
      ],
    });
    expect(
      readFileSync(path.join(env.HOME, ".codex", "skills", "web-fetch", "SKILL.md"), "utf8"),
    ).toContain("Fetch a page.");
    expect(
      readFileSync(
        path.join(env.HOME, ".codex", "skills", "web-fetch", "templates", "extract.md"),
        "utf8",
      ),
    ).toBe("template");
  });

  test("copies installed skills to the Claude Code skills directory", () => {
    const env = createTempEnv();
    writeKanaSkill(env, "web-search", "Search the web.");

    const result = syncKanaSkills(env, {
      targetAgent: "claude",
    });

    expect(result.targetName).toBe("claude");
    expect(result.targetPath).toBe(path.join(env.HOME, ".claude", "skills"));
    expect(
      readFileSync(path.join(env.HOME, ".claude", "skills", "web-search", "SKILL.md"), "utf8"),
    ).toContain("Search the web.");
  });

  test("honors CLAUDE_CONFIG_DIR for the Claude Code preset", () => {
    const env = createTempEnv();
    const claudeHome = path.join(env.HOME, "claude-config");
    writeKanaSkill(env, "web-search", "Search the web.");

    const result = syncKanaSkills(
      { ...env, CLAUDE_CONFIG_DIR: claudeHome },
      {
        targetAgent: "claude",
      },
    );

    expect(result.targetPath).toBe(path.join(claudeHome, "skills"));
    expect(
      readFileSync(path.join(claudeHome, "skills", "web-search", "SKILL.md"), "utf8"),
    ).toContain("Search the web.");
  });

  test("rejects unknown target agents", () => {
    const env = createTempEnv();
    writeKanaSkill(env, "web-search", "Search the web.");

    expect(() => syncKanaSkills(env, { targetAgent: "cursor" })).toThrow(
      "Unknown skills sync target: cursor. Supported targets: codex, claude.",
    );
  });

  test("sync skips existing target skills", () => {
    const env = createTempEnv();
    writeKanaSkill(env, "web-search", "Search the web.");
    writeFile(path.join(env.HOME, ".codex", "skills", "web-search", "SKILL.md"), "local edit");

    const result = syncKanaSkills(env, {
      targetAgent: "codex",
    });

    expect(result.skills).toEqual([
      {
        name: "web-search",
        sourcePath: path.join(env.KANA_HOME, "skills", "kana-skills", "web-search"),
        status: "exists",
        targetPath: path.join(env.HOME, ".codex", "skills", "web-search"),
      },
    ]);
    expect(
      readFileSync(path.join(env.HOME, ".codex", "skills", "web-search", "SKILL.md"), "utf8"),
    ).toBe("local edit");
  });

  test("resync replaces matching target skills without deleting other Skills", () => {
    const env = createTempEnv();
    writeKanaSkill(env, "web-search", "Search the web.");
    const targetRoot = path.join(env.HOME, ".codex", "skills");
    writeFile(path.join(targetRoot, "web-search", "SKILL.md"), "local edit");
    writeFile(path.join(targetRoot, "stale-kana-skill", "SKILL.md"), "stale");
    writeFile(path.join(targetRoot, "personal", "SKILL.md"), "personal");

    const result = resyncKanaSkills(env, {
      targetAgent: "codex",
    });

    expect(result.skills[0]?.status).toBe("replaced");
    expect(readFileSync(path.join(targetRoot, "web-search", "SKILL.md"), "utf8")).toContain(
      "Search the web.",
    );
    expect(readFileSync(path.join(targetRoot, "stale-kana-skill", "SKILL.md"), "utf8")).toBe(
      "stale",
    );
    expect(readFileSync(path.join(targetRoot, "personal", "SKILL.md"), "utf8")).toBe("personal");
  });

  test("resync keeps files ignored by the skill's .gitignore", () => {
    const env = createTempEnv();
    const sourcePath = writeKanaSkill(env, "notes", "Write notes.");
    writeFile(path.join(sourcePath, ".gitignore"), "/drafts/*\n!/drafts/.gitkeep\n.env\n");
    writeFile(path.join(sourcePath, "drafts", ".gitkeep"), "");
    initGitRepository(env);
    const targetRoot = path.join(env.HOME, ".codex", "skills");
    syncKanaSkills(env, { targetAgent: "codex" });
    writeFile(path.join(targetRoot, "notes", "drafts", "post-1", "card.png"), "draft");
    writeFile(path.join(targetRoot, "notes", ".env"), "KEY=secret");
    writeFile(path.join(targetRoot, "notes", "scripts", "stale.py"), "stale");
    mkdirSync(path.join(targetRoot, "notes", "drafts", "post-1", "source"), { recursive: true });

    const result = resyncKanaSkills(env, { targetAgent: "codex" });

    expect(result.skills[0]?.status).toBe("replaced");
    expect(
      readFileSync(path.join(targetRoot, "notes", "drafts", "post-1", "card.png"), "utf8"),
    ).toBe("draft");
    expect(readFileSync(path.join(targetRoot, "notes", ".env"), "utf8")).toBe("KEY=secret");
    expect(existsSync(path.join(targetRoot, "notes", "drafts", ".gitkeep"))).toBe(true);
    expect(existsSync(path.join(targetRoot, "notes", "scripts"))).toBe(false);
    expect(existsSync(path.join(targetRoot, "notes", "drafts", "post-1", "source"))).toBe(true);
  });

  test("does not copy files ignored in the source skill", () => {
    const env = createTempEnv();
    const sourcePath = writeKanaSkill(env, "notes", "Write notes.");
    writeFile(path.join(sourcePath, ".gitignore"), "/drafts/*\n.env\nnode_modules/\n");
    writeFile(path.join(sourcePath, "drafts", "kana-post", "card.png"), "kana draft");
    writeFile(path.join(sourcePath, ".env"), "KEY=kana");
    writeFile(path.join(sourcePath, "node_modules", "dep", "index.js"), "dep");
    initGitRepository(env);
    const targetSkill = path.join(env.HOME, ".codex", "skills", "notes");

    syncKanaSkills(env, { targetAgent: "codex" });

    expect(readFileSync(path.join(targetSkill, "SKILL.md"), "utf8")).toContain("Write notes.");
    expect(readFileSync(path.join(targetSkill, ".gitignore"), "utf8")).toContain(".env");
    expect(existsSync(path.join(targetSkill, "drafts", "kana-post"))).toBe(false);
    expect(existsSync(path.join(targetSkill, ".env"))).toBe(false);
    expect(existsSync(path.join(targetSkill, "node_modules"))).toBe(false);
  });

  test("copies to a custom target directory", () => {
    const env = createTempEnv();
    const targetDir = path.join(env.HOME, "other-agent", "skills");
    writeKanaSkill(env, "web-search", "Search the web.");

    const result = syncKanaSkills(env, {
      targetDir,
    });

    expect(result.targetName).toBe("custom");
    expect(result.targetPath).toBe(targetDir);
    expect(readFileSync(path.join(targetDir, "web-search", "SKILL.md"), "utf8")).toContain(
      "Search the web.",
    );
  });

  test("requires the default skills repository to be installed first", () => {
    const env = createTempEnv();

    expect(() => syncKanaSkills(env, { targetAgent: "codex" })).toThrow(
      `Cannot sync skills because ${path.join(
        env.KANA_HOME,
        "skills",
        "kana-skills",
      )} does not exist. Run kana skills install first.`,
    );
  });
});

function writeKanaSkill(env: TempEnv, name: string, description: string): string {
  const skillPath = path.join(env.KANA_HOME, "skills", "kana-skills", name);

  writeFile(
    path.join(skillPath, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${description}`, "---", "", `# ${name}`, ""].join("\n"),
  );

  return skillPath;
}

function initGitRepository(env: TempEnv): void {
  const result = spawnSync("git", ["init", "--quiet"], {
    cwd: path.join(env.KANA_HOME, "skills", "kana-skills"),
  });
  expect(result.status).toBe(0);
}

function writeFile(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

type TempEnv = NodeJS.ProcessEnv & { HOME: string; KANA_HOME: string };

function createTempEnv(): TempEnv {
  const tempDir = mkdtempSync(path.join(tmpdir(), "kana-skill-sync-"));
  tempDirs.push(tempDir);

  return {
    HOME: path.join(tempDir, "home"),
    KANA_HOME: path.join(tempDir, ".kana"),
  };
}
