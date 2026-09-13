import { escapeXml } from "../format";
import type { KanaSkill } from "./types";

export function formatKanaSkillsForPrompt(skills: readonly KanaSkill[]): string {
  if (skills.length === 0) {
    return "";
  }

  return [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description. The read tool has a per-call limit — always page through with offset to read the entire file before acting on the skill's instructions.",
    "When a skill file references a relative path, resolve it against the skill directory, which is the parent directory of SKILL.md.",
    "",
    "<available_skills>",
    ...skills.flatMap((skill) => [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.filePath)}</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}
