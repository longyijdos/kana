import { formatKanaSkillInvocation, type KanaSkillActivation } from "@/kana";
import { collapseWhitespace } from "../../render";
import type { PromptSubmit } from "./commands";

export type SkillReferenceState = {
  isSkillMode: boolean;
  showPalette: boolean;
  query: string;
  suggestions: KanaSkillActivation[];
};

export function getSkillReferenceState(
  value: string,
  skills: readonly KanaSkillActivation[],
): SkillReferenceState {
  if (!value.startsWith("@")) {
    return {
      isSkillMode: false,
      showPalette: false,
      query: "",
      suggestions: [],
    };
  }

  const tokenEnd = findSkillTokenEnd(value);
  const query = value.slice(1, tokenEnd);

  return {
    isSkillMode: true,
    showPalette: tokenEnd === value.length,
    query,
    suggestions: skills.filter((skill) => skill.name.startsWith(query)),
  };
}

export function completeSkillReference(skill: KanaSkillActivation): string {
  return `@${skill.name} `;
}

export function formatSkillReferenceHelpLine(
  skill: KanaSkillActivation,
  skills: readonly KanaSkillActivation[],
): string {
  const syntax = `@${skill.name}`;
  const width = Math.max(...skills.map((candidate) => candidate.name.length + 1), syntax.length);
  return `${syntax.padEnd(width)} ${collapseWhitespace(skill.description)}`;
}

export function createSkillReferenceSubmit(
  value: string,
  selectedSkill: KanaSkillActivation | undefined,
  skills: readonly KanaSkillActivation[],
): PromptSubmit {
  const state = getSkillReferenceState(value, skills);
  const skill =
    skills.find((candidate) => candidate.name === state.query) ??
    (state.showPalette && state.suggestions.length > 0 ? selectedSkill : undefined);

  if (!skill) {
    return { type: "message", content: value };
  }

  return {
    type: "message",
    content: formatKanaSkillInvocation(skill, value.slice(findSkillTokenEnd(value))),
    raw: value,
  };
}

function findSkillTokenEnd(value: string): number {
  const match = /^@\S*/.exec(value);
  return match ? match[0].length : value.length;
}
