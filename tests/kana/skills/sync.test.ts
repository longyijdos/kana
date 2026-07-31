import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
