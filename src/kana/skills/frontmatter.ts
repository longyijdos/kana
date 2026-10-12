import { readFileSync } from "node:fs";
import path from "node:path";
import { formatError } from "@/utils";
import { type FrontmatterFields, readFrontmatter } from "../frontmatter";
import type { KanaSkillDiagnostic, LoadKanaSkillsResult } from "./types";

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

  let frontmatter: FrontmatterFields;
  try {
    frontmatter = readFrontmatter(content)?.fields ?? {};
  } catch (error) {
    return {
      skills: [],
      diagnostics: [
        {
          type: "warning",
          code: "parse_failed",
          message: formatError(error),
          path: filePath,
        },
      ],
    };
  }

  const diagnostics: KanaSkillDiagnostic[] = [];
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
