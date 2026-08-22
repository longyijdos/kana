import type { ToolCallContent } from "@/core";

export type ToolResultPolicyInput = {
  readonly toolCall: Readonly<ToolCallContent>;
  // Policies operate only on provider-facing text. The structured host result
  // stays outside this advisory boundary and therefore needs no cloneability contract.
  readonly content: string;
  readonly isError: boolean;
};

export type ToolResultPolicyResult = {
  // Undefined preserves the normalized tool content. A string replaces only
  // the provider-facing content; structured result data remains unchanged.
  content?: string;
  // ToolRuntime assigns identity and provenance so policy-authored context
  // cannot enter durable history as anonymous user input.
  additionalContext?: readonly string[];
};

export type ToolResultPolicy = {
  readonly source: string;
  finalize(
    input: ToolResultPolicyInput,
  ): Promise<ToolResultPolicyResult | undefined> | ToolResultPolicyResult | undefined;
  reset?(): void;
};
