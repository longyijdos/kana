import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { formatError } from "@/utils";
import { KANA_MODEL_PROVIDERS, type KanaModelProvider } from "../config";
import {
  type FrontmatterFields,
  isKanaResourceName,
  readFrontmatter,
  unquote,
} from "../frontmatter";
import { getKanaConfigPaths } from "../path";

const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_DESCRIPTION_LENGTH = 1024;

export type KanaSubagentProfile = {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly tools: readonly string[];
  readonly model?: {
    readonly provider: KanaModelProvider;
    readonly name: string;
    readonly reasoningEffort?: string;
  };
  readonly sourcePath?: string;
  readonly digest: string;
};

type KanaSubagentProfileDiagnostic = {
  readonly code: "read_failed" | "invalid_profile";
  readonly message: string;
  readonly path: string;
};

export type LoadKanaSubagentProfilesResult = {
  readonly profiles: readonly KanaSubagentProfile[];
  readonly diagnostics: readonly KanaSubagentProfileDiagnostic[];
};

export function loadKanaSubagentProfiles(
  options: { env?: NodeJS.ProcessEnv } = {},
): LoadKanaSubagentProfilesResult {
  const profiles = new Map<string, KanaSubagentProfile>();
  const diagnostics: KanaSubagentProfileDiagnostic[] = [];
  const directory = getKanaConfigPaths(options.env).agentsDirectory;
  if (!existsSync(directory)) {
    return { profiles: [], diagnostics };
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
      profiles: [],
      diagnostics: [{ code: "read_failed", message: formatError(error), path: directory }],
    };
  }

  for (const entry of entries) {
    const name = path.basename(entry, ".md");
    const filePath = path.join(directory, entry);
    try {
      const content = readFileSync(filePath, "utf8");
      if (Buffer.byteLength(content) > MAX_PROFILE_BYTES) {
        throw new Error(`profile exceeds ${MAX_PROFILE_BYTES} bytes`);
      }
      const profile = parseProfile(name, content, filePath);
      profiles.set(profile.name, profile);
    } catch (error) {
      // A card never loads partially: an invalid file stays unavailable.
      diagnostics.push({ code: "invalid_profile", message: formatError(error), path: filePath });
    }
  }

  return {
    profiles: sortedProfiles(profiles),
    diagnostics,
  };
}

const PROFILE_FIELDS = new Set(["description", "tools", "model", "reasoning_effort"]);

function parseProfile(name: string, content: string, filePath: string): KanaSubagentProfile {
  if (!isKanaResourceName(name)) {
    throw new Error("profile filename must be a lowercase hyphenated name up to 64 characters");
  }
  const frontmatter = readFrontmatter(content);
  if (frontmatter === undefined) {
    throw new Error("profile requires frontmatter");
  }
  const { fields } = frontmatter;
  const unknownField = Object.keys(fields).find((key) => !PROFILE_FIELDS.has(key));
  if (unknownField !== undefined) {
    throw new Error(`unknown frontmatter field: ${unknownField}`);
  }
  const instructions = frontmatter.body.trim();
  if (!instructions) {
    throw new Error("profile instructions are required");
  }
  const description = readScalar(fields, "description")?.trim();
  if (!description) {
    throw new Error("description is required");
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  const tools = readTools(fields.tools);
  for (const tool of tools) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(tool)) {
      throw new Error(`invalid tool name: ${tool}`);
    }
  }

  const model = parseModel(readScalar(fields, "model"), readScalar(fields, "reasoning_effort"));
  return withDigest({
    name,
    description,
    instructions,
    tools: [...new Set(tools)],
    ...(model === undefined ? {} : { model }),
    sourcePath: filePath,
  });
}

function readScalar(fields: FrontmatterFields, key: string): string | undefined {
  const value = fields[key];
  if (Array.isArray(value)) {
    throw new Error(`${key} must be a single value`);
  }
  return value as string | undefined;
}

function readTools(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined || value === "" || value === "[]") return [];
  if (typeof value !== "string") return value;
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
