import { isUserImage } from "@/core";
import type { ToolResult } from "./tool";

export function normalizeToolResult(value: unknown): ToolResult {
  if (hasToolResultShape(value)) {
    const images = value.images;
    if (images !== undefined && (!Array.isArray(images) || !images.every(isUserImage))) {
      throw new TypeError("Tool result images must be an array of valid UserImage objects.");
    }
    if (value.isError !== undefined && typeof value.isError !== "boolean") {
      throw new TypeError("Tool result isError must be a boolean when provided.");
    }

    // Detach validated observations at the normalization boundary so a tool
    // cannot mutate them into an invalid provider or session message later.
    return {
      content: value.content,
      ...(images === undefined ? {} : { images: structuredClone(images) }),
      result: value.result,
      ...(value.isError === undefined ? {} : { isError: value.isError }),
    };
  }

  return {
    content: stringifyToolContent(value),
    result: value,
  };
}

function hasToolResultShape(
  value: unknown,
): value is Record<string, unknown> & { content: string; result: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    typeof value.content === "string" &&
    "result" in value
  );
}

function stringifyToolContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}
