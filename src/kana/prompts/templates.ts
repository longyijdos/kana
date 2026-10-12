import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { formatError } from "@/utils";
import { readFrontmatter } from "../frontmatter";
import { getKanaConfigPaths } from "../path";

const MAX_TEMPLATE_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const PLACEHOLDER_PATTERN = /\{\{\s*([a-z][a-z0-9_-]{0,63})\s*(?:=([^}\r\n]*))?\}\}/g;

type KanaPromptTemplateArgument = {
  readonly name: string;
  readonly defaultValue?: string;
};

export type KanaPromptTemplate = {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly arguments: readonly KanaPromptTemplateArgument[];
  readonly sourcePath: string;
};

type KanaPromptTemplateDiagnostic = {
  readonly code: "read_failed" | "invalid_template";
  readonly message: string;
  readonly path: string;
};

type LoadKanaPromptTemplatesResult = {
  readonly templates: readonly KanaPromptTemplate[];
  readonly diagnostics: readonly KanaPromptTemplateDiagnostic[];
};

export function loadKanaPromptTemplates(
  options: { env?: NodeJS.ProcessEnv } = {},
): LoadKanaPromptTemplatesResult {
  const directory = getKanaConfigPaths(options.env).promptTemplatesDirectory;
  if (!existsSync(directory)) {
    return { templates: [], diagnostics: [] };
  }

  let entries: string[];
  try {
    entries = readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."),
      )
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    return {
      templates: [],
      diagnostics: [{ code: "read_failed", message: formatError(error), path: directory }],
    };
  }

  const templates: KanaPromptTemplate[] = [];
  const diagnostics: KanaPromptTemplateDiagnostic[] = [];
  for (const entry of entries) {
    const filePath = path.join(directory, entry);
    try {
      const content = readFileSync(filePath, "utf8");
      if (Buffer.byteLength(content) > MAX_TEMPLATE_BYTES) {
        throw new Error(`template exceeds ${MAX_TEMPLATE_BYTES} bytes`);
      }
      templates.push(parsePromptTemplate(path.basename(entry, ".md"), content, filePath));
    } catch (error) {
      diagnostics.push({
        code: "invalid_template",
        message: formatError(error),
        path: filePath,
      });
    }
  }

  return { templates, diagnostics };
}

export function expandKanaPromptTemplate(template: KanaPromptTemplate, input: string): string {
  const supplied = parseNamedArguments(template.name, input);
  const declared = new Set(template.arguments.map((argument) => argument.name));
  for (const name of supplied.keys()) {
    if (!declared.has(name)) {
      throw new Error(`Prompt template :${template.name} has no argument named "${name}".`);
    }
  }

  const values = new Map<string, string>();
  const missing: string[] = [];
  for (const argument of template.arguments) {
    const value = supplied.get(argument.name) ?? argument.defaultValue;
    if (value === undefined) {
      missing.push(argument.name);
    } else {
      values.set(argument.name, value);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Prompt template :${template.name} requires ${missing.map((name) => `${name}=<value>`).join(", ")}.`,
    );
  }

  return template.body.replace(PLACEHOLDER_PATTERN, (_placeholder, name: string) => {
    return values.get(name) ?? "";
  });
}

function parsePromptTemplate(name: string, content: string, filePath: string): KanaPromptTemplate {
  validateName(name);
  const frontmatter = readFrontmatter(content);
  if (frontmatter === undefined) {
    throw new Error("template requires frontmatter");
  }
  const unknownField = Object.keys(frontmatter.fields).find((key) => key !== "description");
  if (unknownField !== undefined) {
    throw new Error(`unknown frontmatter field: ${unknownField}`);
  }
  const rawDescription = frontmatter.fields.description;
  const description = typeof rawDescription === "string" ? rawDescription.trim() : undefined;
  if (!description) {
    throw new Error("description is required");
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  const body = frontmatter.body.trim();
  if (!body) {
    throw new Error("template body is required");
  }

  return {
    name,
    description,
    body,
    arguments: parsePlaceholders(body),
    sourcePath: filePath,
  };
}

function parsePlaceholders(body: string): KanaPromptTemplateArgument[] {
  const argumentsByName = new Map<string, KanaPromptTemplateArgument>();
  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1] ?? "";
    const defaultValue = match[2]?.trim();
    const existing = argumentsByName.get(name);
    if (existing) {
      if (existing.defaultValue !== defaultValue) {
        throw new Error(`placeholder "${name}" has inconsistent defaults`);
      }
      continue;
    }
    argumentsByName.set(name, {
      name,
      ...(defaultValue === undefined ? {} : { defaultValue }),
    });
  }
  return [...argumentsByName.values()];
}

function parseNamedArguments(templateName: string, input: string): Map<string, string> {
  const result = new Map<string, string>();
  let offset = 0;
  while (offset < input.length) {
    while (/\s/.test(input[offset] ?? "")) offset += 1;
    if (offset >= input.length) break;

    const nameMatch = /^[a-z][a-z0-9_-]*/.exec(input.slice(offset));
    if (!nameMatch) {
      throw invalidArgumentsError(templateName, input, offset);
    }
    const name = nameMatch[0];
    offset += name.length;
    if (input[offset] !== "=") {
      throw invalidArgumentsError(templateName, input, offset);
    }
    offset += 1;

    let value = "";
    const quote = input[offset] === '"' || input[offset] === "'" ? input[offset] : undefined;
    if (quote) {
      offset += 1;
      let closed = false;
      while (offset < input.length) {
        const character = input[offset] ?? "";
        const next = input[offset + 1];
        if (character === "\\" && (next === quote || next === "\\")) {
          value += next;
          offset += 2;
          continue;
        }
        if (character === quote) {
          closed = true;
          offset += 1;
          break;
        }
        value += character;
        offset += 1;
      }
      if (!closed || (offset < input.length && !/\s/.test(input[offset] ?? ""))) {
        throw invalidArgumentsError(templateName, input, offset);
      }
    } else {
      const valueStart = offset;
      while (offset < input.length && !/\s/.test(input[offset] ?? "")) offset += 1;
      value = input.slice(valueStart, offset);
    }

    if (result.has(name)) {
      throw new Error(
        `Prompt template :${templateName} received argument "${name}" more than once.`,
      );
    }
    result.set(name, value);
  }
  return result;
}

function invalidArgumentsError(templateName: string, input: string, offset: number): Error {
  const near = input.slice(Math.max(0, offset - 12), offset + 24).trim();
  return new Error(
    `Prompt template :${templateName} expects name=value arguments${near ? ` near "${near}"` : ""}.`,
  );
}

function validateName(name: string): void {
  if (
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
  ) {
    throw new Error("template filename must be a lowercase hyphenated name up to 64 characters");
  }
}
