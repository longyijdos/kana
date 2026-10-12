import { escapeXml } from "@/utils";
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

export function formatKanaSkillInvocation(skill: KanaSkill, request: string): string {
  const instruction = [
    `[User explicitly selected the ${JSON.stringify(skill.name)} Skill for this request.]`,
    `Use this Skill to complete the request below. Read and follow ${JSON.stringify(skill.filePath)} completely, resolving relative paths from ${JSON.stringify(skill.baseDir)}.`,
  ].join("\n");
  const normalizedRequest = request.trim();

  return normalizedRequest ? `${instruction}\n\n${normalizedRequest}` : instruction;
}
