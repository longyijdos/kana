import type { ToolCallContent } from "@/core";
import {
  DEFAULT_GLOB_LIMIT,
  DEFAULT_GREP_INCLUDE,
  DEFAULT_GREP_LIMIT,
  DEFAULT_LIST_LIMIT,
  DEFAULT_READ_LIMIT,
  DEFAULT_TIMEOUT_MS,
} from "@/tools";
import { stripTerminalControlSequences } from "../render";
import { getBooleanProperty, getNumberProperty, getStringProperty } from "./properties";

export type ToolApprovalSource = {
  kind: "mcp";
  serverId: string;
  remoteToolName: string;
};

// Full-fidelity detail: content is never summarized or truncated here;
// wrapping/paging/truncation stay in the consuming component.
export type ToolDetailSection = {
  label: string;
  content: string;
};

export type ToolDetail = {
  title: string;
  sections: ToolDetailSection[];
};

// The optional `source` carries MCP provenance that does not live in
// ToolCallContent today.
export function buildFullToolDetail(
  toolCall: ToolCallContent,
  source?: ToolApprovalSource,
): ToolDetail {
  if (source?.kind === "mcp") {
    return {
      title: mcpDetailTitle(source),
      sections: [
        buildSection("Server", sanitizeToolDetailLabel(source.serverId)),
        buildSection("Tool", sanitizeToolDetailLabel(source.remoteToolName)),
        buildSection("Arguments", formatSanitizedArguments(toolCall.args ?? {}) ?? "{}"),
      ],
    };
  }

  return {
    title: toolDetailTitle(toolCall.name),
    sections: buildToolSections(toolCall, true),
  };
}

// Operation context for the inspector. Can write content and edit old/new
// text be omitted from the context? Only the caller knows whether the rich
// full output renderers below actually recovered them (see the inspector),
// so `includeMaterial` is an explicit decision: material payloads stay in
// the context whenever the output renderers cannot present them.
export function buildToolInspectorContext(
  toolCall: ToolCallContent,
  includeMaterial: boolean,
): ToolDetailSection[] {
  return buildToolSections(toolCall, includeMaterial);
}

// Label row per section, content rows indented, blank row between sections.
export function formatFullToolDetail(detail: ToolDetail): string {
  return detail.sections.map(formatSection).join("\n\n");
}

export function sanitizeToolOutput(value: unknown): unknown {
  if (typeof value === "string") {
    return stripTerminalControlSequences(value);
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeToolOutput);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizeToolOutput(entry)]),
  );
}

// Provenance labels (server id, remote tool name) also collapse line breaks
// since they render on one row.
export function sanitizeToolDetailLabel(value: string): string {
  return stripTerminalControlSequences(value).replace(/[\r\n]+/g, " ");
}

function toolDetailTitle(toolName: string): string {
  // Unknown/custom tool names are model/MCP-provided and must be sanitized
  // before they become a renderable title.
  return BUILT_IN_TOOL_TITLES.get(toolName) ?? sanitizeToolDetailLabel(toolName);
}

// Single source of truth for Kana-owned tool names: the inspector renders
// their raw result through "Output", while custom/unknown results are the
// generic payload under "Result".
export function isBuiltInToolName(toolName: string): boolean {
  return BUILT_IN_TOOL_TITLES.has(toolName);
}

const BUILT_IN_TOOL_TITLES = new Map<string, string>([
  ["bash", "Bash"],
  ["list", "List"],
  ["glob", "Glob"],
  ["grep", "Grep"],
  ["read", "Read"],
  ["write", "Write"],
  ["edit", "Edit"],
  ["view_image", "View image"],
  ["remember", "Remember"],
  ["schedule_wake", "Schedule wake"],
]);

function mcpDetailTitle(source: ToolApprovalSource): string {
  return `MCP ${sanitizeToolDetailLabel(source.serverId)} · ${sanitizeToolDetailLabel(source.remoteToolName)}`;
}

function buildToolSections(
  toolCall: ToolCallContent,
  includeMaterial: boolean,
): ToolDetailSection[] {
  const args = toolCall.args;
  const sections: ToolDetailSection[] = [];

  switch (toolCall.name) {
    case "bash": {
      pushSection(sections, "Command", getStringProperty(args, "command"));
      // Final execution semantics: an omitted cwd/timeout use the runtime
      // defaults, so both are always visible rather than deleted from the
      // detail when the model happens to omit them.
      pushSection(sections, "Working directory", getStringProperty(args, "cwd") ?? ".");
      pushSection(
        sections,
        "Timeout",
        formatNumber(getNumberProperty(args, "timeoutMs") ?? DEFAULT_TIMEOUT_MS, " ms"),
      );
      break;
    }

    case "write": {
      pushSection(sections, "Path", getStringProperty(args, "path"));
      if (includeMaterial) {
        pushSection(sections, "Content", getStringProperty(args, "content"));
      }
      if (getBooleanProperty(args, "overwrite") === true) {
        pushSection(sections, "Overwrite", "replaces the existing file");
      }
      break;
    }

    case "edit": {
      pushSection(sections, "Path", getStringProperty(args, "path"));
      if (includeMaterial) {
        pushSection(sections, "Replace", getStringProperty(args, "oldText"));
        pushSection(sections, "With", getStringProperty(args, "newText"));
      }
      if (getBooleanProperty(args, "replaceAll") === true) {
        pushSection(sections, "Replace all", "every occurrence in the file");
      }
      break;
    }

    case "read": {
      pushSection(sections, "Path", getStringProperty(args, "path"));
      // Final execution semantics: offset defaults to 1 and an omitted limit
      // reads DEFAULT_READ_LIMIT lines — the runtime never reads "to the end
      // of the file", so the reachable range is always explicit.
      const offset = getNumberProperty(args, "offset") ?? 1;
      const limit = getNumberProperty(args, "limit") ?? DEFAULT_READ_LIMIT;

      pushSection(sections, "Lines", `${offset}-${offset + limit - 1}`);
      break;
    }

    case "view_image": {
      pushSection(sections, "Path", getStringProperty(args, "path"));
      break;
    }

    case "list": {
      pushSection(sections, "Path", getStringProperty(args, "path") ?? ".");
      // Final semantics: included unless the model explicitly excludes them.
      pushSection(
        sections,
        "Hidden entries",
        getBooleanProperty(args, "includeHidden") === false ? "excluded" : "included",
      );
      pushSection(
        sections,
        "Limit",
        formatNumber(getNumberProperty(args, "limit") ?? DEFAULT_LIST_LIMIT),
      );
      break;
    }

    case "glob": {
      pushSection(sections, "Pattern", getStringProperty(args, "pattern"));
      pushSection(sections, "Directory", getStringProperty(args, "cwd") ?? ".");
      pushSection(sections, "Type", getStringProperty(args, "type") ?? "file");
      pushSection(sections, "Max depth", formatNumber(getNumberProperty(args, "maxDepth")));
      pushSection(
        sections,
        "Hidden entries",
        getBooleanProperty(args, "includeHidden") === true ? "included" : "excluded",
      );
      pushSection(
        sections,
        "Limit",
        formatNumber(getNumberProperty(args, "limit") ?? DEFAULT_GLOB_LIMIT),
      );
      break;
    }

    case "grep": {
      pushSection(sections, "Pattern", getStringProperty(args, "pattern"));
      pushSection(sections, "Path", getStringProperty(args, "path") ?? ".");
      pushSection(sections, "Include", getStringProperty(args, "include") ?? DEFAULT_GREP_INCLUDE);
      pushSection(
        sections,
        "Match",
        getBooleanProperty(args, "literal") === true ? "literal text" : "regular expression",
      );
      pushSection(
        sections,
        "Case",
        getBooleanProperty(args, "caseSensitive") === false ? "insensitive" : "sensitive",
      );
      pushSection(
        sections,
        "Hidden entries",
        getBooleanProperty(args, "includeHidden") === true ? "included" : "excluded",
      );
      pushSection(
        sections,
        "Limit",
        formatNumber(getNumberProperty(args, "limit") ?? DEFAULT_GREP_LIMIT),
      );
      break;
    }

    case "remember": {
      pushSection(sections, "Content", getStringProperty(args, "content"));
      // Final execution semantics: an omitted scope defaults to project, so
      // the effective scope is always shown (matching rememberParameters /
      // appendKanaMemory).
      pushSection(sections, "Scope", getStringProperty(args, "scope") ?? "project");
      pushSection(sections, "Title", getStringProperty(args, "title"));
      pushSection(sections, "Reason", getStringProperty(args, "reason"));
      break;
    }

    case "schedule_wake": {
      const afterMinutes = getNumberProperty(args, "afterMinutes");

      if (afterMinutes !== undefined) {
        pushSection(
          sections,
          "Delay",
          `${afterMinutes} ${afterMinutes === 1 ? "minute" : "minutes"}`,
        );
      }
      pushSection(sections, "Message", getStringProperty(args, "message"));
      pushSection(sections, "Key", getStringProperty(args, "key"));
      break;
    }

    default: {
      // Unknown/custom tool names are model/MCP-provided; keep the complete
      // sanitized identity recoverable in the body because fixed approval or
      // inspector titles truncate to the viewport width.
      pushSection(sections, "Tool", sanitizeToolDetailLabel(toolCall.name));
      pushSection(sections, "Arguments", formatSanitizedArguments(args));
      break;
    }
  }

  return sections;
}

function pushSection(
  sections: ToolDetailSection[],
  label: string,
  content: string | undefined,
): void {
  if (content === undefined || content === "") {
    return;
  }

  sections.push({ label, content: stripTerminalControlSequences(content) });
}

function buildSection(label: string, content: string): ToolDetailSection {
  return { label, content };
}

function formatNumber(value: number | undefined, suffix = ""): string | undefined {
  return value === undefined ? undefined : `${value}${suffix}`;
}

// Pretty-prints sanitized args as JSON; undefined when there are no args.
function formatSanitizedArguments(args: unknown): string | undefined {
  if (args === undefined) {
    return undefined;
  }

  try {
    const formatted = JSON.stringify(sanitizeToolOutput(args), null, 2);

    return formatted === undefined ? sanitizeToolDetailLabel(String(args)) : formatted;
  } catch {
    // A non-serializable value still must not leak control sequences.
    return sanitizeToolDetailLabel(String(args));
  }
}

function formatSection(section: ToolDetailSection): string {
  const body = section.content
    .split("\n")
    .map((line) => (line === "" ? "" : `  ${line}`))
    .join("\n");

  return `${section.label}\n${body}`;
}
