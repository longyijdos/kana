import path from "node:path";

import type { ToolResultPolicy, ToolResultPolicyResult } from "@/agent";
import type { ToolCallContent, ToolResultArtifact } from "@/core";
import type { Logger } from "@/logging";
import type { KanaSessionArtifactStore } from "./store";

const TOOL_RESULT_ARTIFACT_POLICY_SOURCE = "session_artifact";
const HEAD_RATIO = 0.7;

export type KanaToolResultArtifactPolicyOptions = {
  store: KanaSessionArtifactStore;
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
      const resultExceedsLimit =
        input.resultByteLength === undefined || input.resultByteLength > byteLimit;

      if (contentByteLength <= byteLimit) {
        if (!resultExceedsLimit) {
          return undefined;
        }
        log(options.logger, "info", "tool.result_persistence_bounded", {
          toolName: input.toolCall.name,
          reason: input.resultByteLength === undefined ? "not_serializable" : "result_oversized",
          inlineByteLimit: byteLimit,
        });
        return { persistResult: false };
      }

      if (input.toolCall.name === "read") {
        const { content } = createBoundedPreview(
          input.content,
          byteLimit,
          (omittedBytes) =>
            `\n\n[Read output truncated: ${omittedBytes} UTF-8 bytes omitted. Call read again with offset and limit to inspect the missing section.]\n\n`,
        );
        return {
          content,
          ...(resultExceedsLimit ? { persistResult: false as const } : {}),
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
        log(options.logger, "info", "tool.result_artifact_saved", {
          toolName: input.toolCall.name,
          contentByteLength,
          inlineByteLimit: byteLimit,
          omittedByteLength: omittedBytes,
        });
        return {
          content,
          artifact: savedArtifact,
          persistResult: false,
        };
      } catch (error) {
        if (artifact) {
          await options.store.discard(artifact).catch((cleanupError) => {
            log(options.logger, "warn", "tool.result_artifact_cleanup_failed", {
              phase: "save_rollback",
              errorType: getErrorType(cleanupError),
              errorCode: getErrorCode(cleanupError),
            });
          });
        }
        log(options.logger, "warn", "tool.result_artifact_save_failed", {
          toolName: input.toolCall.name,
          phase: artifact ? "preview" : "write",
          errorType: getErrorType(error),
          errorCode: getErrorCode(error),
        });
        // Storage is advisory. Preserve the normalized outcome and let the
        // existing context guard apply its ordinary model-facing fallback.
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
    "Use read with this locator plus offset/limit, or grep with this locator plus pattern.",
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

function sliceUtf8Prefix(content: string, maxBytes: number): string {
  let bytes = 0;
  let index = 0;
  while (index < content.length) {
    const codePoint = content.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const character = String.fromCodePoint(codePoint);
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (bytes + nextBytes > maxBytes) {
      break;
    }
    bytes += nextBytes;
    index += character.length;
  }
  return content.slice(0, index);
}

function sliceUtf8Suffix(content: string, maxBytes: number): string {
  let bytes = 0;
  let index = content.length;
  while (index > 0) {
    const previousIndex =
      index >= 2 && isLowSurrogate(content.charCodeAt(index - 1)) ? index - 2 : index - 1;
    const character = content.slice(previousIndex, index);
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (bytes + nextBytes > maxBytes) {
      break;
    }
    bytes += nextBytes;
    index = previousIndex;
  }
  return content.slice(index);
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function getErrorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function log(
  logger: Logger | undefined,
  level: "info" | "warn",
  event: string,
  metadata: Record<string, unknown>,
): void {
  try {
    logger?.[level](event, metadata);
  } catch {
    // Diagnostics must not change result finalization or cleanup behavior.
  }
}
