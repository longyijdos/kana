import { readFileSync } from "node:fs";
import path from "node:path";

import { formatError } from "../format";
import type { KanaSkillDiagnostic, LoadKanaSkillsResult, SkillFrontmatter } from "./types";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export function loadSkillFromFile(filePath: string): LoadKanaSkillsResult {
  let content: string;

  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    return {
      skills: [],
      diagnostics: [
        {
          type: "warning",
          code: "read_failed",
          message: formatError(error),
          path: filePath,
        },
      ],
    };
  }

  const parsed = parseFrontmatter(content);

  if (!parsed.ok) {
    return {
      skills: [],
      diagnostics: [
        {
          type: "warning",
          code: "parse_failed",
          message: parsed.error,
          path: filePath,
        },
      ],
    };
  }

  const diagnostics: KanaSkillDiagnostic[] = [];
  const frontmatter = parsed.frontmatter;
  const description =
    typeof frontmatter.description === "string" ? frontmatter.description : undefined;

  for (const error of validateDescription(description)) {
    diagnostics.push({
      type: "warning",
      code: "invalid_metadata",
      message: error,
      path: filePath,
    });
  }

  const baseDir = path.dirname(filePath);
  const fallbackName =
    path.basename(filePath) === "SKILL.md"
      ? path.basename(baseDir)
      : path.basename(filePath, path.extname(filePath));
  const name = typeof frontmatter.name === "string" ? frontmatter.name : fallbackName;

  for (const error of validateName(name)) {
    diagnostics.push({
      type: "warning",
      code: "invalid_metadata",
      message: error,
      path: filePath,
    });
  }

  if (!description || description.trim() === "") {
    return {
      skills: [],
      diagnostics,
    };
  }

  return {
    skills: [
      {
        name,
        description,
        filePath,
        baseDir,
      },
    ],
    diagnostics,
  };
}

function parseFrontmatter(
  content: string,
): { ok: true; frontmatter: SkillFrontmatter } | { ok: false; error: string } {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (!normalized.startsWith("---\n")) {
    return {
      ok: true,
      frontmatter: {},
    };
  }

  const endIndex = normalized.indexOf("\n---", 4);

  if (endIndex === -1) {
    return {
      ok: false,
      error: "frontmatter is missing a closing --- marker",
    };
  }

  return parseMetadataBlock(normalized.slice(4, endIndex));
}

function parseMetadataBlock(
  content: string,
): { ok: true; frontmatter: SkillFrontmatter } | { ok: false; error: string } {
  const frontmatter: SkillFrontmatter = {};
  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);

    if (!match) {
      return {
        ok: false,
        error: `invalid frontmatter line: ${line}`,
      };
    }

    const key = match[1];
    const rawValue = match[2] ?? "";

    if (rawValue === "|" || rawValue === ">") {
      const blockLines: string[] = [];

      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1] ?? "")) {
        index += 1;
        blockLines.push((lines[index] ?? "").replace(/^ {2}/, ""));
      }

      setFrontmatterValue(frontmatter, key, blockLines.join("\n"));
      continue;
    }

    setFrontmatterValue(frontmatter, key, parseScalar(rawValue.trim()));
  }

  return {
    ok: true,
    frontmatter,
  };
}

function setFrontmatterValue(
  frontmatter: SkillFrontmatter,
  key: string,
  value: string | boolean,
): void {
  switch (key) {
    case "name":
    case "description":
      if (typeof value === "string") {
        frontmatter[key] = value;
      }
      break;
  }
}

function parseScalar(value: string): string | boolean {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);

  return quoted ? (quoted[1] ?? "") : value;
}

function validateName(name: string): string[] {
  const errors: string[] = [];

  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }

  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push("name contains invalid characters");
  }

  if (name.startsWith("-") || name.endsWith("-")) {
    errors.push("name must not start or end with a hyphen");
  }

  if (name.includes("--")) {
    errors.push("name must not contain consecutive hyphens");
  }

  return errors;
}

function validateDescription(description: string | undefined): string[] {
  if (!description || description.trim() === "") {
    return ["description is required"];
  }

  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return [`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`];
  }

  return [];
}
