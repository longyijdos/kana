import { sanitizeToolDetailLabel } from "./detail";
import { getBooleanProperty, getStringProperty } from "./properties";

export const overwriteMarker = "[OVERWRITE]";
export const backgroundMarker = "[BACKGROUND]";

// Per-tool wording for the transcript, approval prompt, and status line.
export function toolText(
  toolName: string,
  target: string | undefined,
  args?: unknown,
  requesterName = "Kana",
): {
  action: string;
  approvalTitle: string;
  doneTitle: string;
  runningActivity: string;
} {
  switch (toolName) {
    case "run_code":
      return {
        action: "run code",
        approvalTitle: `Allow ${requesterName} to run code?`,
        doneTitle: "Ran code",
        runningActivity: "running code",
      };
    case "mcp_call": {
      const name = `${getStringProperty(args, "server") ?? "?"}/${getStringProperty(args, "tool") ?? "?"}`;
      return {
        action: `call MCP ${name}`,
        approvalTitle: `Allow ${requesterName} to use MCP tool?`,
        doneTitle: `Called MCP ${name}`,
        runningActivity: `calling MCP ${name}`,
      };
    }
    case "mcp_get_tool": {
      const name = `${getStringProperty(args, "server") ?? "?"}/${getStringProperty(args, "tool") ?? "?"}`;
      return {
        action: `describe MCP ${name}`,
        approvalTitle: `Allow ${requesterName} to read MCP tool details?`,
        doneTitle: `Described MCP ${name}`,
        runningActivity: `describing MCP ${name}`,
      };
    }
    case "mcp_list_tools": {
      const name = getStringProperty(args, "name") ?? "?";
      return {
        action: `list MCP tools for ${name}`,
        approvalTitle: `Allow ${requesterName} to read MCP catalog?`,
        doneTitle: `Listed MCP tools for ${name}`,
        runningActivity: `listing MCP tools for ${name}`,
      };
    }
    case "list":
      return {
        action: `list ${target}`,
        approvalTitle: `Allow ${requesterName} to list directory?`,
        doneTitle: `Listed ${target}`,
        runningActivity: `listing ${target}`,
      };
    case "glob":
      return {
        action: `match ${target}`,
        approvalTitle: `Allow ${requesterName} to find paths?`,
        doneTitle: `Matched ${target}`,
        runningActivity: `matching ${target}`,
      };
    case "grep":
      return {
        action: `search ${target}`,
        approvalTitle: `Allow ${requesterName} to search files?`,
        doneTitle: `Searched ${target}`,
        runningActivity: `searching ${target}`,
      };
    case "read":
      return {
        action: `read ${target}`,
        approvalTitle: `Allow ${requesterName} to read file?`,
        doneTitle: `Read ${target}`,
        runningActivity: `reading ${target}`,
      };
    case "view_image":
      return {
        action: `view ${target}`,
        approvalTitle: `Allow ${requesterName} to view image?`,
        doneTitle: `Viewed ${target}`,
        runningActivity: `viewing ${target}`,
      };
    case "write":
      return {
        action: withOverwriteMarker(`create ${target}`, args),
        approvalTitle: withOverwriteMarker(`Allow ${requesterName} to create file?`, args),
        doneTitle: withOverwriteMarker(`Created ${target}`, args),
        runningActivity: withOverwriteMarker(`creating ${target}`, args),
      };
    case "edit":
      return {
        action: `edit ${target}`,
        approvalTitle: `Allow ${requesterName} to edit file?`,
        doneTitle: `Edited ${target}`,
        runningActivity: `editing ${target}`,
      };
    case "job_start":
      return {
        action: `run ${target} ${backgroundMarker}`,
        approvalTitle: `Allow ${requesterName} to start background job? ${backgroundMarker}`,
        doneTitle: `Ran ${target} ${backgroundMarker}`,
        runningActivity: `running ${target} ${backgroundMarker}`,
      };
    case "shell":
      return {
        action: `run ${target}`,
        approvalTitle: `Allow ${requesterName} to run shell?`,
        doneTitle: `Ran ${target}`,
        runningActivity: `running ${target}`,
      };
    case "remember":
      return {
        action: "save memory",
        approvalTitle: `Allow ${requesterName} to save memory?`,
        doneTitle: `Saved ${target} memory`,
        runningActivity: `saving ${target} memory`,
      };
    case "schedule_wake":
      return {
        action: "schedule wake",
        approvalTitle: `Allow ${requesterName} to schedule a wake?`,
        doneTitle: `Scheduled wake ${target}`,
        runningActivity: `scheduling wake ${target}`,
      };
    case "update_goal":
      return {
        action: "update goal",
        approvalTitle: `Allow ${requesterName} to update the goal?`,
        doneTitle: target === "completed" ? "Completed goal" : "Blocked goal",
        runningActivity: "updating goal",
      };
    default:
      return {
        action: `use ${toolName}`,
        // Custom/unknown tool names are model/MCP-provided; only the
        // approval title sanitizes the identity because it renders on a
        // fixed row. Transcript action/done/running wording keeps the raw
        // name so compact rendering stays unchanged.
        approvalTitle: `Allow ${requesterName} to use ${sanitizeToolDetailLabel(toolName)}?`,
        doneTitle: `Used ${toolName}`,
        runningActivity: `using ${toolName}`,
      };
  }
}

function withOverwriteMarker(text: string, args: unknown): string {
  return getBooleanProperty(args, "overwrite") ? `${text} ${overwriteMarker}` : text;
}

export function formatStatusActivity(activity: string, suffix: string): string {
  const marker = [overwriteMarker, backgroundMarker].find((candidate) =>
    activity.endsWith(` ${candidate}`),
  );
  if (!marker) {
    return `${activity}${suffix}`;
  }

  return `${activity.slice(0, -marker.length - 1)}${suffix} ${marker}`;
}
