import type { ToolCallContent } from "@/core";
import type { ToolResultPolicy } from "./tool-result-policy";

const REPEATED_TOOL_CALL_POLICY_SOURCE = "repeated_tool_call";

export type RepeatedToolCallPolicyConfig = {
  reminderThresholds: readonly number[];
  excludedTools?: readonly string[];
};

export function createRepeatedToolCallPolicy(
  config: RepeatedToolCallPolicyConfig,
): ToolResultPolicy {
  const reminderThresholds = validateReminderThresholds(config.reminderThresholds);
  const excludedTools = new Set(validateExcludedTools(config.excludedTools ?? []));
  let previousKey: string | undefined;
  let repeatCount = 0;

  return {
    source: REPEATED_TOOL_CALL_POLICY_SOURCE,
    finalize({ toolCall }) {
      if (excludedTools.has(toolCall.name)) {
        return;
      }

      const key = canonicalizeToolCall(toolCall);
      if (key === previousKey) {
        repeatCount += 1;
      } else {
        previousKey = key;
        repeatCount = 1;
      }

      const thresholdIndex = reminderThresholds.indexOf(repeatCount);
      if (thresholdIndex === -1) {
        return;
      }

      return {
        additionalContext: [
          formatRepeatedCallReminder(
            toolCall.name,
            repeatCount,
            thresholdIndex,
            reminderThresholds.length,
          ),
        ],
      };
    },
    reset() {
      previousKey = undefined;
      repeatCount = 0;
    },
  };
}

function validateReminderThresholds(values: readonly number[]): number[] {
  let previous = 1;
  const thresholds: number[] = [];

  for (const value of values) {
    if (!Number.isInteger(value) || value < 2 || value <= previous) {
      throw new Error(
        "reminderThresholds must contain strictly increasing integers greater than or equal to 2.",
      );
    }
    thresholds.push(value);
    previous = value;
  }

  return thresholds;
}

function validateExcludedTools(values: readonly string[]): string[] {
  const tools = new Set<string>();

  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
      throw new Error("excludedTools must contain non-empty trimmed tool names.");
    }
    if (tools.has(value)) {
      throw new Error("excludedTools must not contain duplicate tool names.");
    }
    tools.add(value);
  }

  return [...tools];
}

function canonicalizeToolCall(toolCall: Readonly<ToolCallContent>): string {
  return canonicalizeJson([toolCall.name, toolCall.args], new Set<object>());
}

function canonicalizeJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error("Tool arguments must contain only finite JSON numbers.");
      }
      return JSON.stringify(value);
    case "object": {
      if (ancestors.has(value)) {
        throw new Error("Tool arguments cannot contain circular references.");
      }
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${Array.from(value, (item) => canonicalizeJson(item, ancestors)).join(",")}]`;
        }
        if (!isPlainJsonObject(value)) {
          throw new Error("Tool arguments must contain only JSON objects and arrays.");
        }

        return `{${Object.keys(value)
          .sort()
          .map(
            (key) =>
              `${JSON.stringify(key)}:${canonicalizeJson(
                (value as Record<string, unknown>)[key],
                ancestors,
              )}`,
          )
          .join(",")}}`;
      } finally {
        ancestors.delete(value);
      }
    }
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new Error("Tool arguments must be valid JSON values.");
  }

  throw new Error("Tool arguments must be valid JSON values.");
}

function isPlainJsonObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function formatRepeatedCallReminder(
  toolName: string,
  repeatCount: number,
  thresholdIndex: number,
  thresholdCount: number,
): string {
  const guidance =
    thresholdIndex === 0
      ? "Check whether this is making progress before requesting the same call again."
      : thresholdIndex === thresholdCount - 1
        ? "The current approach appears stuck. Choose a materially different next step unless repetition is explicitly necessary."
        : "The current approach may be stuck. Reassess the latest result and change strategy before repeating it.";

  return [
    "[Repeated tool-call reminder]",
    `The exact same ${JSON.stringify(toolName)} call has now been requested ${repeatCount} consecutive times.`,
    guidance,
    "This reminder is advisory; the tool call was not blocked.",
  ].join("\n");
}
