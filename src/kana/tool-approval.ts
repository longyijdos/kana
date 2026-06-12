import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import type { ToolCallContent } from "@/core";
import { getKanaConfigPaths, type KanaToolApprovalConfig } from "./config";

export type KanaToolApprovals = {
  version: 1;
  bash: {
    commands: string[];
  };
};

export const DEFAULT_KANA_TOOL_APPROVALS: KanaToolApprovals = {
  version: 1,
  bash: {
    commands: [],
  },
};

export function shouldRequestToolApproval(
  config: KanaToolApprovalConfig,
  approvals: KanaToolApprovals,
  toolCall: ToolCallContent,
): boolean {
  switch (config.mode) {
    case "always":
      return true;
    case "never":
      return false;
    case "unless_trusted":
      return !isTrustedToolCall(approvals, toolCall);
  }
}

export function isBashToolCall(toolCall: ToolCallContent): boolean {
  return toolCall.name === "bash";
}

export function getBashCommand(toolCall: ToolCallContent): string | undefined {
  if (!isBashToolCall(toolCall)) {
    return undefined;
  }

  return readBashCommand(toolCall.args);
}

export function addTrustedBashCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): KanaToolApprovals {
  const normalized = normalizeBashCommand(command);

  if (!normalized) {
    return loadKanaToolApprovals(env);
  }

  const approvals = loadKanaToolApprovals(env);

  if (approvals.bash.commands.includes(normalized)) {
    return approvals;
  }

  const nextApprovals: KanaToolApprovals = {
    ...approvals,
    bash: {
      commands: [...approvals.bash.commands, normalized],
    },
  };

  saveKanaToolApprovals(nextApprovals, env);

  return nextApprovals;
}

export function loadKanaToolApprovals(
  env: NodeJS.ProcessEnv = process.env,
): KanaToolApprovals {
  const { approvalsPath } = getKanaConfigPaths(env);

  if (!existsSync(approvalsPath)) {
    return structuredClone(DEFAULT_KANA_TOOL_APPROVALS);
  }

  const parsed = JSON.parse(readFileSync(approvalsPath, "utf8")) as unknown;

  return readKanaToolApprovals(parsed);
}

export function saveKanaToolApprovals(
  approvals: KanaToolApprovals,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const { home, approvalsPath } = getKanaConfigPaths(env);

  mkdirSync(home, { recursive: true });
  writeFileSync(approvalsPath, `${JSON.stringify(approvals, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function isTrustedToolCall(
  approvals: KanaToolApprovals,
  toolCall: ToolCallContent,
): boolean {
  if (toolCall.name === "read") {
    return true;
  }

  const command = getBashCommand(toolCall);

  return (
    command !== undefined &&
    approvals.bash.commands.includes(normalizeBashCommand(command))
  );
}

function readBashCommand(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return undefined;
  }

  const command = (args as Record<string, unknown>).command;

  return typeof command === "string" ? normalizeBashCommand(command) : undefined;
}

function normalizeBashCommand(command: string): string {
  return command.trim();
}

function readKanaToolApprovals(rawApprovals: unknown): KanaToolApprovals {
  const raw = asRecord(rawApprovals, "approvals");
  const bash = raw.bash === undefined ? {} : asRecord(raw.bash, "approvals.bash");

  if (raw.version !== 1) {
    throw new Error("approvals.version must be 1.");
  }

  return {
    version: 1,
    bash: {
      commands: readStringArray(
        bash.commands,
        DEFAULT_KANA_TOOL_APPROVALS.bash.commands,
        "approvals.bash.commands",
      ),
    },
  };
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function readStringArray(
  value: unknown,
  fallback: string[],
  name: string,
): string[] {
  if (value === undefined) {
    return fallback.slice();
  }

  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(`${name} must be an array of non-empty strings.`);
  }

  return [...new Set(value.map(normalizeBashCommand).filter(Boolean))];
}
