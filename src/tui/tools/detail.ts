import type { ToolCallContent } from "@/core";
import {
  DEFAULT_GLOB_LIMIT,
  DEFAULT_GREP_INCLUDE,
  DEFAULT_GREP_LIMIT,
  DEFAULT_LIST_LIMIT,
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
    sections: buildBuiltInSections(toolCall),
  };
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
  switch (toolName) {
    case "bash":
      return "Bash";
    case "list":
      return "List";
    case "glob":
      return "Glob";
    case "grep":
      return "Grep";
    case "read":
      return "Read";
    case "write":
      return "Write";
    case "edit":
      return "Edit";
    case "view_image":
      return "View image";
    case "remember":
      return "Remember";
    case "schedule_wake":
      return "Schedule wake";
    // Unknown/custom tool names are model/MCP-provided and must be sanitized
    // before they become a renderable title.
    default:
      return sanitizeToolDetailLabel(toolName);
  }
}

function mcpDetailTitle(source: ToolApprovalSource): string {
  return `MCP ${sanitizeToolDetailLabel(source.serverId)} · ${sanitizeToolDetailLabel(source.remoteToolName)}`;
}

function buildBuiltInSections(toolCall: ToolCallContent): ToolDetailSection[] {
  const args = toolCall.args;
  const sections: ToolDetailSection[] = [];

  switch (toolCall.name) {
    case "bash": {
      pushSection(sections, "Command", getStringProperty(args, "command"));
      pushSection(sections, "Working directory", getStringProperty(args, "cwd"));
      pushSection(sections, "Timeout", formatNumber(getNumberProperty(args, "timeoutMs"), " ms"));
      break;
    }

    case "write": {
      pushSection(sections, "Path", getStringProperty(args, "path"));
      pushSection(sections, "Content", getStringProperty(args, "content"));
      if (getBooleanProperty(args, "overwrite") === true) {
        pushSection(sections, "Overwrite", "replaces the existing file");
      }
      break;
    }

    case "edit": {
      pushSection(sections, "Path", getStringProperty(args, "path"));
      pushSection(sections, "Replace", getStringProperty(args, "oldText"));
      pushSection(sections, "With", getStringProperty(args, "newText"));
      if (getBooleanProperty(args, "replaceAll") === true) {
        pushSection(sections, "Replace all", "every occurrence in the file");
      }
      break;
    }

    case "read": {
      pushSection(sections, "Path", getStringProperty(args, "path"));
      // offset defaults to 1; an omitted limit reads to the end of the file.
      const offset = getNumberProperty(args, "offset");
      const limit = getNumberProperty(args, "limit");

      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "end";

        pushSection(sections, "Lines", `${startLine}-${endLine}`);
      }
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
      pushSection(sections, "Scope", getStringProperty(args, "scope"));
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
export function formatSanitizedArguments(args: unknown): string | undefined {
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
