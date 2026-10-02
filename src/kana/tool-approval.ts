import type { ToolCallContent } from "@/core";
import type { KanaToolApprovalConfig } from "./config";
import {
  readOptionalConfigFile,
  withLockedConfigFile,
  writeConfigFileAtomically,
} from "./config/file-storage";
import { getKanaConfigPaths } from "./path";

export {
  DEFAULT_KANA_TOOL_APPROVALS,
  type KanaToolApprovals,
} from "./tool-approval-defaults";

import { DEFAULT_KANA_TOOL_APPROVALS, type KanaToolApprovals } from "./tool-approval-defaults";

const ALWAYS_APPROVAL_TOOLS = new Set<string>(["delegate_user_task"]);

export type KanaToolApprovalStore = {
  load(): KanaToolApprovals;
  addTrustedShellCommand(command: string): KanaToolApprovals;
};

export function shouldRequestToolApproval(
  config: KanaToolApprovalConfig,
  approvals: KanaToolApprovals,
  toolCall: ToolCallContent,
): boolean {
  if (ALWAYS_APPROVAL_TOOLS.has(toolCall.name)) {
    return true;
  }
  if (
    toolCall.name === "mcp_list_tools" ||
    toolCall.name === "mcp_describe_tool" ||
    toolCall.name === "remember" ||
    toolCall.name === "schedule_wake" ||
    toolCall.name === "todo_write" ||
    toolCall.name === "update_goal" ||
    toolCall.name === "spawn_subagent" ||
    toolCall.name === "wait_subagent" ||
    toolCall.name === "cancel_subagent"
  ) {
    return false;
  }

  switch (config.mode) {
    case "always":
      return true;
    case "never":
      return false;
    case "unless_trusted":
      return !isTrustedToolCall(approvals, toolCall);
  }
}

function isShellToolCall(toolCall: ToolCallContent): boolean {
  return toolCall.name === "shell";
}

export function getShellCommand(toolCall: ToolCallContent): string | undefined {
  if (!isShellToolCall(toolCall)) {
    return undefined;
  }

  return readShellCommand(toolCall.args);
}

export function addTrustedShellCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): KanaToolApprovals {
  const normalized = normalizeShellCommand(command);

  if (!normalized) {
    return loadKanaToolApprovals(env);
  }

  const { approvalsPath } = getKanaConfigPaths(env);
  return withLockedConfigFile(approvalsPath, () => {
    const approvals = readApprovalsFile(readOptionalConfigFile(approvalsPath));

    if (approvals.shell.exactCommands.includes(normalized)) {
      return approvals;
    }

    const nextApprovals: KanaToolApprovals = {
      ...approvals,
      shell: {
        ...approvals.shell,
        exactCommands: [...approvals.shell.exactCommands, normalized],
      },
    };
    writeConfigFileAtomically(approvalsPath, `${JSON.stringify(nextApprovals, null, 2)}\n`);
    return nextApprovals;
  });
}

export function createKanaToolApprovalStore(
  env: NodeJS.ProcessEnv = process.env,
): KanaToolApprovalStore {
  let snapshot = loadKanaToolApprovals(env);

  return {
    load: () => structuredClone(snapshot),
    addTrustedShellCommand(command) {
      const normalized = normalizeShellCommand(command);
      if (!normalized || snapshot.shell.exactCommands.includes(normalized)) {
        return structuredClone(snapshot);
      }

      addTrustedShellCommand(normalized, env);
      snapshot = {
        ...snapshot,
        shell: {
          ...snapshot.shell,
          exactCommands: [...snapshot.shell.exactCommands, normalized],
        },
      };
      return structuredClone(snapshot);
    },
  };
}

export function loadKanaToolApprovals(env: NodeJS.ProcessEnv = process.env): KanaToolApprovals {
  const { approvalsPath } = getKanaConfigPaths(env);

  return readApprovalsFile(readOptionalConfigFile(approvalsPath));
}

function isTrustedToolCall(approvals: KanaToolApprovals, toolCall: ToolCallContent): boolean {
  if (
    toolCall.name === "read" ||
    toolCall.name === "list" ||
    toolCall.name === "glob" ||
    toolCall.name === "grep" ||
    toolCall.name === "view_image" ||
    toolCall.name === "job_list" ||
    toolCall.name === "job_output" ||
    toolCall.name === "job_kill"
  ) {
    return true;
  }

  const command = getShellCommand(toolCall);

  return (
    command !== undefined &&
    (approvals.shell.exactCommands.includes(normalizeShellCommand(command)) ||
      isTrustedReadOnlyShellCommand(approvals, command))
  );
}

function readShellCommand(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return undefined;
  }

  const command = (args as Record<string, unknown>).command;

  return typeof command === "string" ? normalizeShellCommand(command) : undefined;
}

function normalizeShellCommand(command: string): string {
  return command.trim();
}

function isTrustedReadOnlyShellCommand(approvals: KanaToolApprovals, command: string): boolean {
  const executable = readSimpleShellExecutable(command);

  return executable !== undefined && approvals.shell.readOnlyCommands.includes(executable);
}

function readSimpleShellExecutable(command: string): string | undefined {
  const normalized = normalizeShellCommand(command);

  // This whitelist is intentionally limited to a single simple command. Shell
  // composition can turn an otherwise read-only executable into a write.
  if (!normalized || /[;&|<>()`$\\\n\r]/.test(normalized)) {
    return undefined;
  }

  const executable = normalized.match(/^\S+/)?.[0];

  if (executable === undefined || executable.includes("/")) {
    return undefined;
  }

  return executable;
}

function readKanaToolApprovals(rawApprovals: unknown): KanaToolApprovals {
  const raw = asRecord(rawApprovals, "approvals");

  if (raw.version !== 3) {
    throw new Error("approvals.version must be 3.");
  }
  const shell = raw.shell === undefined ? {} : asRecord(raw.shell, "approvals.shell");

  return {
    version: 3,
    shell: {
      exactCommands: readStringArray(
        shell.exactCommands,
        DEFAULT_KANA_TOOL_APPROVALS.shell.exactCommands,
        "approvals.shell.exactCommands",
      ),
      readOnlyCommands: readStringArray(
        shell.readOnlyCommands,
        DEFAULT_KANA_TOOL_APPROVALS.shell.readOnlyCommands,
        "approvals.shell.readOnlyCommands",
      ).map((command) => readShellExecutableName(command, "approvals.shell.readOnlyCommands")),
    },
  };
}

function readApprovalsFile(content: string | undefined): KanaToolApprovals {
  return content === undefined
    ? structuredClone(DEFAULT_KANA_TOOL_APPROVALS)
    : readKanaToolApprovals(JSON.parse(content) as unknown);
}

function readShellExecutableName(value: string, name: string): string {
  if (/\s/.test(value) || value.includes("/")) {
    throw new Error(`${name} entries must be executable names.`);
  }

  return value;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function readStringArray(value: unknown, fallback: string[], name: string): string[] {
  if (value === undefined) {
    return fallback.slice();
  }

  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(`${name} must be an array of non-empty strings.`);
  }

  return [...new Set(value.map(normalizeShellCommand).filter(Boolean))];
}
