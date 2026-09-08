import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { KANA_MODEL_PROVIDERS, type KanaModelProvider } from "../config";
import { formatError } from "../format";
import { getKanaConfigPaths } from "../path";

const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export type KanaSubagentProfile = {
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  model?: {
    provider: KanaModelProvider;
    name: string;
    reasoningEffort?: string;
  };
  source: "builtin" | "user";
  sourcePath?: string;
  digest: string;
};

type KanaSubagentProfileDiagnostic = {
  code: "read_failed" | "invalid_profile";
  message: string;
  path: string;
};

export type LoadKanaSubagentProfilesResult = {
  profiles: KanaSubagentProfile[];
  diagnostics: KanaSubagentProfileDiagnostic[];
};

type ParsedFrontmatter = {
  description?: string;
  tools?: string[];
  model?: string;
  reasoningEffort?: string;
};

const BUILT_IN_PROFILES: ReadonlyArray<Omit<KanaSubagentProfile, "digest">> = [
  {
    name: "explorer",
    description: "Investigate a codebase and return evidence without modifying files.",
    instructions:
      "You are a repository explorer. Investigate the delegated task thoroughly, cite concrete file paths and symbols, and return a concise evidence-backed result. Do not modify files.",
    tools: ["list", "glob", "grep", "read", "view_image"],
    source: "builtin",
  },
  {
    name: "worker",
    description: "Implement a bounded change using workspace and configured external tools.",
    instructions:
      "You are an implementation worker. Complete only the delegated task, follow repository instructions, make cohesive changes, and report the result and relevant verification.",
    tools: ["list", "glob", "grep", "read", "view_image", "write", "edit", "bash", "mcp:*"],
    source: "builtin",
  },
  {
    name: "reviewer",
    description: "Review existing changes for correctness, regressions, and missing coverage.",
    instructions:
      "You are a code reviewer. Inspect the delegated change, prioritize concrete correctness and regression risks, and report findings with file references. Do not modify files.",
    tools: ["list", "glob", "grep", "read", "view_image", "bash"],
    source: "builtin",
  },
];

export function loadKanaSubagentProfiles(
  options: { env?: NodeJS.ProcessEnv; builtinsOnly?: boolean } = {},
): LoadKanaSubagentProfilesResult {
  const profiles = new Map(
    BUILT_IN_PROFILES.map((profile) => [profile.name, withDigest(profile)] as const),
  );
  const diagnostics: KanaSubagentProfileDiagnostic[] = [];
  if (options.builtinsOnly) {
    return { profiles: sortedProfiles(profiles), diagnostics };
  }
  const directory = getKanaConfigPaths(options.env).agentsDirectory;
  if (!existsSync(directory)) {
    return { profiles: sortedProfiles(profiles), diagnostics };
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
      profiles: sortedProfiles(profiles),
      diagnostics: [{ code: "read_failed", message: formatError(error), path: directory }],
    };
  }

  for (const entry of entries) {
    const name = path.basename(entry, ".md");
    const filePath = path.join(directory, entry);
    // A user file deliberately shadows a built-in of the same name. Invalid
    // overrides stay unavailable instead of silently changing permissions.
    profiles.delete(name);
    try {
      const content = readFileSync(filePath, "utf8");
      if (Buffer.byteLength(content) > MAX_PROFILE_BYTES) {
        throw new Error(`profile exceeds ${MAX_PROFILE_BYTES} bytes`);
      }
      const profile = parseProfile(name, content, filePath);
      profiles.set(profile.name, profile);
    } catch (error) {
      diagnostics.push({ code: "invalid_profile", message: formatError(error), path: filePath });
    }
  }

  return {
    profiles: sortedProfiles(profiles),
    diagnostics,
  };
}

function parseProfile(name: string, content: string, filePath: string): KanaSubagentProfile {
  validateName(name);
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error("profile requires frontmatter");
  }
  const delimitedEnd = normalized.indexOf("\n---\n", 4);
  const end =
    delimitedEnd >= 0 ? delimitedEnd : normalized.endsWith("\n---") ? normalized.length - 4 : -1;
  if (end < 0) {
    throw new Error("frontmatter is missing a closing --- marker");
  }
  const frontmatter = parseMetadata(normalized.slice(4, end));
  const instructions = normalized.slice(end + 4).trim();
  if (!instructions) {
    throw new Error("profile instructions are required");
  }
  const description = frontmatter.description?.trim();
  if (!description) {
    throw new Error("description is required");
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  const tools = frontmatter.tools ?? [];
  for (const tool of tools) {
    if (tool !== "mcp:*" && !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(tool)) {
      throw new Error(`invalid tool name: ${tool}`);
    }
  }

  const model = parseModel(frontmatter.model, frontmatter.reasoningEffort);
  return withDigest({
    name,
    description,
    instructions,
    tools: [...new Set(tools)],
    ...(model === undefined ? {} : { model }),
    source: "user",
    sourcePath: filePath,
  });
}

function parseMetadata(content: string): ParsedFrontmatter {
  const result: ParsedFrontmatter = {};
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (!match) throw new Error(`invalid frontmatter line: ${line}`);
    const key = match[1];
    const value = (match[2] ?? "").trim();
    switch (key) {
      case "description":
        result.description = unquote(value);
        break;
      case "model":
        result.model = unquote(value);
        break;
      case "reasoning_effort":
        result.reasoningEffort = unquote(value);
        break;
      case "tools": {
        if (value) {
          result.tools = parseInlineList(value);
          break;
        }
        const tools: string[] = [];
        while (index + 1 < lines.length && /^\s+-\s+/.test(lines[index + 1] ?? "")) {
          index += 1;
          tools.push(unquote((lines[index] ?? "").replace(/^\s+-\s+/, "").trim()));
        }
        result.tools = tools;
        break;
      }
      default:
        throw new Error(`unknown frontmatter field: ${key}`);
    }
  }
  return result;
}

function parseInlineList(value: string): string[] {
  if (value === "[]") return [];
  if (!value.startsWith("[") || !value.endsWith("]")) {
    throw new Error("tools must be a YAML list or inline array");
  }
  const inner = value.slice(1, -1).trim();
  return inner ? inner.split(",").map((item) => unquote(item.trim())) : [];
}

function parseModel(
  value: string | undefined,
  reasoningEffort: string | undefined,
): KanaSubagentProfile["model"] {
  if (reasoningEffort === "") {
    throw new Error("reasoning_effort cannot be empty");
  }
  if (value === undefined || value === "inherit") {
    if (reasoningEffort !== undefined && reasoningEffort !== "inherit") {
      throw new Error("reasoning_effort requires an explicit model");
    }
    return undefined;
  }
  const separator = value.indexOf("/");
  const provider = value.slice(0, separator) as KanaModelProvider;
  const name = value.slice(separator + 1);
  if (separator <= 0 || !name || !KANA_MODEL_PROVIDERS.includes(provider)) {
    throw new Error("model must be inherit or <provider>/<name>");
  }
  return {
    provider,
    name,
    ...(reasoningEffort === undefined || reasoningEffort === "inherit" ? {} : { reasoningEffort }),
  };
}

function validateName(name: string): void {
  if (
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
  ) {
    throw new Error("profile filename must be a lowercase hyphenated name up to 64 characters");
  }
}

function unquote(value: string): string {
  const match = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
  return match?.[1] ?? value;
}

function withDigest(profile: Omit<KanaSubagentProfile, "digest">): KanaSubagentProfile {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        name: profile.name,
        description: profile.description,
        instructions: profile.instructions,
        tools: profile.tools,
        model: profile.model,
      }),
    )
    .digest("hex");
  return { ...profile, tools: [...profile.tools], digest };
}

function sortedProfiles(profiles: ReadonlyMap<string, KanaSubagentProfile>): KanaSubagentProfile[] {
  return [...profiles.values()].sort((left, right) => left.name.localeCompare(right.name));
}
