import { expandKanaPromptTemplate, type KanaPromptTemplate } from "@/kana";

import type { PromptSubmit } from "./commands";

export type PromptTemplateState = {
  isTemplateMode: boolean;
  showPalette: boolean;
  query: string;
  suggestions: KanaPromptTemplate[];
};

export function getPromptTemplateState(
  value: string,
  templates: readonly KanaPromptTemplate[],
): PromptTemplateState {
  if (!value.startsWith(":")) {
    return {
      isTemplateMode: false,
      showPalette: false,
      query: "",
      suggestions: [],
    };
  }

  const tokenEnd = findTemplateTokenEnd(value);
  const query = value.slice(1, tokenEnd);
  return {
    isTemplateMode: true,
    showPalette: tokenEnd === value.length,
    query,
    suggestions: templates.filter((template) => template.name.startsWith(query)),
  };
}

export function completePromptTemplate(template: KanaPromptTemplate): string {
  return `:${template.name} `;
}

export function formatPromptTemplateHelpLine(
  template: KanaPromptTemplate,
  templates: readonly KanaPromptTemplate[],
): string {
  const syntax = `:${template.name}`;
  const width = Math.max(...templates.map((candidate) => candidate.name.length + 1), syntax.length);
  return `${syntax.padEnd(width)} ${template.description}`;
}

export function createPromptTemplateSubmit(
  value: string,
  selectedTemplate: KanaPromptTemplate | undefined,
  templates: readonly KanaPromptTemplate[],
): PromptSubmit {
  const state = getPromptTemplateState(value, templates);
  const template =
    templates.find((candidate) => candidate.name === state.query) ??
    (state.showPalette && state.suggestions.length > 0 ? selectedTemplate : undefined);

  if (!template) {
    return { type: "message", content: value };
  }

  return {
    type: "message",
    content: expandKanaPromptTemplate(template, getTemplateArguments(value)),
  };
}

function findTemplateTokenEnd(value: string): number {
  const match = /^:\S*/.exec(value);
  return match ? match[0].length : value.length;
}

function getTemplateArguments(value: string): string {
  return value.slice(findTemplateTokenEnd(value)).trim();
}
