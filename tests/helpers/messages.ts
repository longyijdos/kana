import {
  createMessageIdentity,
  type MessageProvenance,
  readMessageId,
  type UserMessageProvenance,
} from "@/core";

export function messageIdForTest(value: string) {
  return readMessageId(value);
}

export function messageIdentityForTest(
  role: "user",
  source?: "scheduled" | "recovery",
): ReturnType<typeof userIdentity>;
export function messageIdentityForTest(role: "assistant"): ReturnType<typeof assistantIdentity>;
export function messageIdentityForTest(role: "tool"): ReturnType<typeof toolIdentity>;
export function messageIdentityForTest(
  role: "user" | "assistant" | "tool",
  source?: "scheduled" | "recovery",
) {
  switch (role) {
    case "user":
      return userIdentity(source);
    case "assistant":
      return assistantIdentity();
    case "tool":
      return toolIdentity();
  }
}

function userIdentity(source?: "scheduled" | "recovery") {
  const provenance: UserMessageProvenance =
    source === "scheduled"
      ? { kind: "scheduled_input", origin: "agent" }
      : source === "recovery"
        ? { kind: "recovery" }
        : { kind: "user_input" };
  return createMessageIdentity(provenance);
}

function assistantIdentity() {
  return createMessageIdentity({ kind: "model_output" } satisfies MessageProvenance);
}

function toolIdentity() {
  return createMessageIdentity({ kind: "tool_result" } satisfies MessageProvenance);
}
