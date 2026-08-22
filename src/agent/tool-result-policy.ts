import type { ToolCallContent, ToolResultArtifact } from "@/core";

export type ToolResultPolicyInput = {
  readonly toolCall: Readonly<ToolCallContent>;
  // Policies operate only on provider-facing text. The structured host result
  // stays outside this advisory boundary and therefore needs no cloneability contract.
  readonly content: string;
  readonly isError: boolean;
  // Policies can make persistence decisions from a bounded measurement
  // without receiving the arbitrary execution-local structured value.
  readonly resultByteLength?: number;
  readonly contentByteLimit?: number;
};

export type ToolResultPolicyResult = {
  // Undefined preserves the normalized tool content. A string replaces only
  // the provider-facing content; structured result data remains unchanged.
  content?: string;
  // ToolRuntime assigns identity and provenance so policy-authored context
  // cannot enter durable history as anonymous user input.
  additionalContext?: readonly string[];
  // Policies may only remove the canonical host result from durable history;
  // they cannot replace it with another arbitrary unbounded value.
  persistResult?: false;
  artifact?: ToolResultArtifact;
};

export type ToolResultPolicy = {
  readonly source: string;
  finalize(
    input: ToolResultPolicyInput,
  ): Promise<ToolResultPolicyResult | undefined> | ToolResultPolicyResult | undefined;
  reset?(): void;
};
