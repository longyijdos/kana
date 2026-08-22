import { describe, expect, test } from "bun:test";
import {
  createRepeatedToolCallPolicy,
  type RepeatedToolCallPolicyConfig,
  type ToolResultPolicy,
  type ToolResultPolicyInput,
  type ToolResultPolicyResult,
} from "../../src/agent";

describe("createRepeatedToolCallPolicy", () => {
  test("matches exact calls with deeply canonicalized object keys and fires each threshold once", async () => {
    const config: RepeatedToolCallPolicyConfig = {
      reminderThresholds: [2, 3],
      excludedTools: ["status"],
    };
    const policy = createRepeatedToolCallPolicy(config);

    expect(
      await finalize(policy, "read", {
        path: "a",
        options: { limit: 10, filters: [{ value: true, field: "active" }] },
      }),
    ).toBeUndefined();
    expect(await finalize(policy, "status", {})).toBeUndefined();

    const second = await finalize(policy, "read", {
      options: { filters: [{ field: "active", value: true }], limit: 10 },
      path: "a",
    });
    const third = await finalize(policy, "read", {
      path: "a",
      options: { limit: 10, filters: [{ value: true, field: "active" }] },
    });

    expect(second?.additionalContext?.[0]).toContain("2 consecutive times");
    expect(second?.additionalContext?.[0]).toContain("advisory; the tool call was not blocked");
    expect(third?.additionalContext?.[0]).toContain("3 consecutive times");
    expect(third?.additionalContext?.[0]).toContain("appears stuck");
    expect(
      await finalize(policy, "read", {
        options: { limit: 10, filters: [{ field: "active", value: true }] },
        path: "a",
      }),
    ).toBeUndefined();
  });

  test("resets the streak for different calls and accepted user input", async () => {
    const policy = createRepeatedToolCallPolicy({ reminderThresholds: [2] });

    expect(await finalize(policy, "read", { path: "a" })).toBeUndefined();
    expect(await finalize(policy, "read", { path: "b" })).toBeUndefined();
    expect(await finalize(policy, "write", { path: "b" })).toBeUndefined();
    expect(await finalize(policy, "write", { path: "b" })).toBeDefined();

    policy.reset?.();

    expect(await finalize(policy, "write", { path: "b" })).toBeUndefined();
  });

  test("validates thresholds and exclusions", () => {
    for (const reminderThresholds of [[1], [3, 3], [4, 3], [2.5]]) {
      expect(() => createRepeatedToolCallPolicy({ reminderThresholds })).toThrow(
        "reminderThresholds must contain strictly increasing integers",
      );
    }
    for (const excludedTools of [[""], [" read"], ["read", "read"]]) {
      expect(() =>
        createRepeatedToolCallPolicy({ reminderThresholds: [2], excludedTools }),
      ).toThrow();
    }
  });
});

async function finalize(
  policy: ToolResultPolicy,
  name: string,
  args: unknown,
): Promise<ToolResultPolicyResult | undefined> {
  const input: ToolResultPolicyInput = {
    toolCall: {
      type: "tool_call",
      id: crypto.randomUUID(),
      name,
      args,
    },
    result: {
      content: "ok",
      result: { ok: true },
    },
    isError: false,
  };
  return policy.finalize(input);
}
