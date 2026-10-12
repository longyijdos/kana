import path from "node:path";

import type { ToolResultPolicy, ToolResultPolicyResult } from "@/agent";
import type { ToolCallContent, ToolResultArtifact } from "@/core";
import type { Logger } from "@/logging";
import { errorFields, sliceUtf8Prefix, sliceUtf8Suffix } from "@/utils";
import type { KanaSessionArtifactStore } from "./store";

const TOOL_RESULT_ARTIFACT_POLICY_SOURCE = "session_artifact";
const HEAD_RATIO = 0.7;

export type KanaToolResultArtifactPolicyOptions = {
  store?: KanaSessionArtifactStore;
  logger?: Logger;
};

export function createKanaToolResultArtifactPolicy(
  options: KanaToolResultArtifactPolicyOptions,
): ToolResultPolicy {
  return {
    source: TOOL_RESULT_ARTIFACT_POLICY_SOURCE,
    async finalize(input): Promise<ToolResultPolicyResult | undefined> {
      if (input.contentByteLimit === undefined) {
        throw new Error("Session artifact policy requires a tool content byte limit.");
      }
      const byteLimit = input.contentByteLimit;
      const contentByteLength = Buffer.byteLength(input.content, "utf8");
      if (contentByteLength <= byteLimit || !options.store) {
        return undefined;
      }

      if (input.toolCall.name === "read") {
        const { content } = createBoundedPreview(
          input.content,
          byteLimit,
          (omittedBytes) =>
            `\n\n[Read output truncated: ${omittedBytes} UTF-8 bytes omitted. Offset and limit can inspect other lines, but cannot page within one very long line.]\n\n`,
        );
        return {
          content,
        };
      }

      let artifact: ToolResultArtifact | undefined;
      try {
        const savedArtifact = await options.store.saveText(
          input.content,
          suggestedArtifactName(input.toolCall),
        );
        artifact = savedArtifact;
        const { content, omittedBytes } = createBoundedPreview(
          input.content,
          byteLimit,
          (omittedByteLength) => formatArtifactNotice(savedArtifact, omittedByteLength),
        );
        options.logger?.info("tool.result_artifact_saved", {
          toolName: input.toolCall.name,
          contentByteLength,
          inlineByteLimit: byteLimit,
          omittedByteLength: omittedBytes,
        });
        return {
          content,
          artifact: savedArtifact,
        };
      } catch (error) {
        if (artifact) {
          await options.store.discard(artifact).catch((cleanupError) => {
            options.logger?.warn("tool.result_artifact_cleanup_failed", {
              phase: "save_rollback",
              ...errorFields(cleanupError),
            });
          });
        }
        options.logger?.warn("tool.result_artifact_save_failed", {
          toolName: input.toolCall.name,
          phase: artifact ? "preview" : "write",
          ...errorFields(error),
        });
        return undefined;
      }
    },
  };
}

function suggestedArtifactName(toolCall: Readonly<ToolCallContent>): string {
  if (
    typeof toolCall.args === "object" &&
    toolCall.args !== null &&
    !Array.isArray(toolCall.args)
  ) {
    const requestedPath = (toolCall.args as Record<string, unknown>).path;
    if (typeof requestedPath === "string" && requestedPath.length > 0) {
      return path.basename(requestedPath);
    }
  }
  return toolCall.name;
}

function formatArtifactNotice(artifact: ToolResultArtifact, omittedBytes: number): string {
  return [
    "",
    "",
    `[Tool output stored as a session artifact: ${omittedBytes} UTF-8 bytes omitted from this preview.]`,
    `Full output locator: ${artifact.locator}`,
    "Use grep with this locator plus pattern to locate text; for line-oriented output, use read with this locator plus offset/limit.",
    "",
    "",
  ].join("\n");
}

function createBoundedPreview(
  content: string,
  maxBytes: number,
  createNotice: (omittedBytes: number) => string,
): { content: string; omittedBytes: number } {
  const contentBytes = Buffer.byteLength(content, "utf8");
  const reservedNotice = createNotice(contentBytes);
  const availableBytes = maxBytes - Buffer.byteLength(reservedNotice, "utf8");
  if (availableBytes < 0) {
    throw new Error("The inline byte limit cannot contain the artifact retrieval notice.");
  }

  const prefix = sliceUtf8Prefix(content, Math.floor(availableBytes * HEAD_RATIO));
  const suffix = sliceUtf8Suffix(content, Math.ceil(availableBytes * (1 - HEAD_RATIO)));
  const retainedBytes = Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(suffix, "utf8");
  const omittedBytes = contentBytes - retainedBytes;
  const notice = createNotice(omittedBytes);
  const preview = `${prefix}${notice}${suffix}`;
  if (Buffer.byteLength(preview, "utf8") > maxBytes) {
    throw new Error("The bounded artifact preview exceeded its inline byte limit.");
  }
  return { content: preview, omittedBytes };
}
