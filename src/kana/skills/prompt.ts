import path from "node:path";

import { getKanaConfigPaths } from "../config";
import { escapeXml } from "../format";
import { loadEnabledGlobalSkillNames } from "./config";
import { isPathInside } from "./paths";
import type { KanaSkill } from "./types";

export type FormatKanaSkillsForPromptOptions = {
  env?: NodeJS.ProcessEnv;
};

export function formatKanaSkillsForPrompt(
  skills: KanaSkill[],
  options: FormatKanaSkillsForPromptOptions = {},
): string {
  const visibleSkills = selectSkillsForPrompt(skills, options);

  if (visibleSkills.length === 0) {
    return "";
  }

  return [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory, which is the parent directory of SKILL.md.",
    "",
    "<available_skills>",
    ...visibleSkills.flatMap((skill) => [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.filePath)}</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}

function selectSkillsForPrompt(
  skills: KanaSkill[],
  options: FormatKanaSkillsForPromptOptions,
): KanaSkill[] {
  const { home } = getKanaConfigPaths(options.env);
  const globalSkillsDir = path.join(home, "skills");
  const enabledGlobalSkills = loadEnabledGlobalSkillNames(globalSkillsDir);

  return skills.filter((skill) => {
    if (!isPathInside(skill.filePath, globalSkillsDir)) {
      return true;
    }

    return enabledGlobalSkills.has(skill.name);
  });
}
