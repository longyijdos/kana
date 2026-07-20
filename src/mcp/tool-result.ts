import type { ToolResult } from "@/tools";
import type { McpResponseError } from "./errors";
import {
  isJsonObject,
  type JsonObject,
  type McpCallToolResult,
  type McpToolContent,
} from "./protocol";

export type McpToolSource = {
  serverId: string;
  remoteToolName: string;
};

export type McpToolResultLimits = {
  maxContentItems: number;
  maxTextCharacters: number;
  maxStructuredCharacters: number;
  maxModelContentCharacters: number;
  maxMetadataCharacters: number;
};

export const DEFAULT_MCP_TOOL_RESULT_LIMITS: Readonly<McpToolResultLimits> = {
  maxContentItems: 64,
  maxTextCharacters: 40_000,
  maxStructuredCharacters: 20_000,
  maxModelContentCharacters: 40_000,
  maxMetadataCharacters: 512,
};

export type McpNormalizedContent =
  | {
      type: "text";
      text: string;
      truncated: boolean;
    }
  | {
      type: "resource_link";
      uri?: string;
      name?: string;
      description?: string;
      mimeType?: string;
    }
  | {
      type: "resource";
      uri?: string;
      mimeType?: string;
      text?: string;
      textTruncated?: boolean;
      blobBytes?: number;
    }
  | {
      type: "binary";
      contentType: "image" | "audio";
      mimeType?: string;
      bytes?: number;
      omitted: true;
    }
  | {
      type: "unsupported";
      contentType: string;
    }
  | {
      type: "invalid";
      contentType: string;
      reason: string;
    };

export type McpNormalizedToolResult = McpToolSource & {
  source: "mcp";
  content: McpNormalizedContent[];
  omittedContentItems: number;
  contentTruncated: boolean;
  structuredContent?: JsonObject;
  structuredContentPreview?: string;
  structuredContentTruncated?: boolean;
  protocolError?: {
    code: number;
    message: string;
    dataPreview?: string;
    dataTruncated?: boolean;
  };
};

type NormalizedContentItem = {
  item: McpNormalizedContent;
  modelText: string;
  naturalText: boolean;
  truncated: boolean;
};

export function normalizeMcpToolResult(
  response: McpCallToolResult,
  source: McpToolSource,
  limitOverrides: Partial<McpToolResultLimits> = {},
): ToolResult<McpNormalizedToolResult> {
  const limits = resolveMcpToolResultLimits(limitOverrides);
  const textBudget = new CharacterBudget(limits.maxTextCharacters);
  const acceptedContent = response.content.slice(0, limits.maxContentItems);
  const normalized = acceptedContent.map((item) => normalizeContentItem(item, textBudget, limits));
  const omittedContentItems = Math.max(0, response.content.length - acceptedContent.length);
  const structured = normalizeStructuredContent(response.structuredContent, limits);
  const modelParts = normalized.map((item) => item.modelText).filter(Boolean);
  const hasNaturalText = normalized.some((item) => item.naturalText);

  if (omittedContentItems > 0) {
    modelParts.push(`[${omittedContentItems} additional MCP content items omitted.]`);
  }
  if (structured?.preview && !hasNaturalText) {
    modelParts.push(`Structured content:\n${structured.preview}`);
  }
  if (modelParts.length === 0) {
    modelParts.push(
      response.isError
        ? "MCP tool reported an error without content."
        : "MCP tool returned no content.",
    );
  }

  const modelContent = truncate(modelParts.join("\n\n"), limits.maxModelContentCharacters);
  const contentTruncated =
    modelContent.truncated ||
    omittedContentItems > 0 ||
    normalized.some((item) => item.truncated) ||
    structured?.truncated === true;
  const result: McpNormalizedToolResult = {
    source: "mcp",
    ...source,
    content: normalized.map((item) => item.item),
    omittedContentItems,
    contentTruncated,
    ...(structured?.value === undefined ? {} : { structuredContent: structured.value }),
    ...(structured?.truncated
      ? {
          structuredContentPreview: structured.preview,
          structuredContentTruncated: true,
        }
      : {}),
  };

  return {
    content: modelContent.value,
    result,
    isError: response.isError ?? false,
  };
}

export function normalizeMcpResponseError(
  error: McpResponseError,
  source: McpToolSource,
  limitOverrides: Partial<McpToolResultLimits> = {},
): ToolResult<McpNormalizedToolResult> {
  const limits = resolveMcpToolResultLimits(limitOverrides);
  const message = truncate(error.responseMessage, limits.maxMetadataCharacters);
  const data = serializePreview(error.data, limits.maxStructuredCharacters);
  const modelContent = truncate(
    `MCP server returned JSON-RPC error ${error.code}: ${message.value}`,
    limits.maxModelContentCharacters,
  );

  return {
    content: modelContent.value,
    result: {
      source: "mcp",
      ...source,
      content: [],
      omittedContentItems: 0,
      contentTruncated: message.truncated || data?.truncated === true || modelContent.truncated,
      protocolError: {
        code: error.code,
        message: message.value,
        ...(data?.preview === undefined ? {} : { dataPreview: data.preview }),
        ...(data?.truncated === undefined ? {} : { dataTruncated: data.truncated }),
      },
    },
    isError: true,
  };
}

export function resolveMcpToolResultLimits(
  overrides: Partial<McpToolResultLimits> = {},
): McpToolResultLimits {
  const limits = {
    ...DEFAULT_MCP_TOOL_RESULT_LIMITS,
    ...overrides,
  };

  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer.`);
    }
  }

  return limits;
}

function normalizeContentItem(
  item: McpToolContent,
  textBudget: CharacterBudget,
  limits: McpToolResultLimits,
): NormalizedContentItem {
  switch (item.type) {
    case "text":
      return normalizeTextContent(item, textBudget);
    case "resource_link":
      return normalizeResourceLink(item, limits);
    case "resource":
      return normalizeEmbeddedResource(item, textBudget, limits);
    case "image":
    case "audio":
      return normalizeBinaryContent(item, limits);
    default: {
      const contentType = truncate(item.type, limits.maxMetadataCharacters).value;
      return {
        item: { type: "unsupported", contentType },
        modelText: `[Unsupported MCP content type omitted: ${contentType}]`,
        naturalText: false,
        truncated: contentType !== item.type,
      };
    }
  }
}

function normalizeTextContent(
  item: McpToolContent,
  textBudget: CharacterBudget,
): NormalizedContentItem {
  if (typeof item.text !== "string") {
    return invalidContent("text", "Missing text string.");
  }

  const text = textBudget.take(item.text);
  return {
    item: { type: "text", text: text.value, truncated: text.truncated },
    modelText: text.value,
    naturalText: text.value.length > 0,
    truncated: text.truncated,
  };
}

function normalizeResourceLink(
  item: McpToolContent,
  limits: McpToolResultLimits,
): NormalizedContentItem {
  if (typeof item.uri !== "string") {
    return invalidContent("resource_link", "Missing resource URI.");
  }

  const uri = optionalMetadata(item.uri, limits);
  const name = optionalMetadata(item.name, limits);
  const description = optionalMetadata(item.description, limits);
  const mimeType = optionalMetadata(item.mimeType, limits);
  const label = name ?? uri ?? "unnamed resource";
  const details = [mimeType, name && uri ? uri : undefined].filter(Boolean).join(", ");

  return {
    item: {
      type: "resource_link",
      ...(uri === undefined ? {} : { uri }),
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(mimeType === undefined ? {} : { mimeType }),
    },
    modelText: `[MCP resource link: ${label}${details ? ` (${details})` : ""}]`,
    naturalText: false,
    truncated:
      wasMetadataTruncated(item.uri, uri) ||
      wasMetadataTruncated(item.name, name) ||
      wasMetadataTruncated(item.description, description) ||
      wasMetadataTruncated(item.mimeType, mimeType),
  };
}

function normalizeEmbeddedResource(
  item: McpToolContent,
  textBudget: CharacterBudget,
  limits: McpToolResultLimits,
): NormalizedContentItem {
  if (!isJsonObject(item.resource)) {
    return invalidContent("resource", "Missing resource object.");
  }

  const resource = item.resource;
  const uri = optionalMetadata(resource.uri, limits);
  const mimeType = optionalMetadata(resource.mimeType, limits);
  const label = uri ?? "embedded resource";

  if (typeof resource.text === "string") {
    const text = textBudget.take(resource.text);
    return {
      item: {
        type: "resource",
        ...(uri === undefined ? {} : { uri }),
        ...(mimeType === undefined ? {} : { mimeType }),
        text: text.value,
        textTruncated: text.truncated,
      },
      modelText: `[MCP resource: ${label}${mimeType ? ` (${mimeType})` : ""}]\n${text.value}`,
      naturalText: text.value.length > 0,
      truncated:
        text.truncated ||
        wasMetadataTruncated(resource.uri, uri) ||
        wasMetadataTruncated(resource.mimeType, mimeType),
    };
  }

  if (typeof resource.blob !== "string") {
    return invalidContent("resource", "Missing resource text or blob.");
  }

  const blobBytes = estimateBase64Bytes(resource.blob);
  return {
    item: {
      type: "resource",
      ...(uri === undefined ? {} : { uri }),
      ...(mimeType === undefined ? {} : { mimeType }),
      ...(blobBytes === undefined ? {} : { blobBytes }),
    },
    modelText: `[MCP binary resource omitted: ${label}${formatBinaryDetails(mimeType, blobBytes)}]`,
    naturalText: false,
    truncated:
      wasMetadataTruncated(resource.uri, uri) || wasMetadataTruncated(resource.mimeType, mimeType),
  };
}

function normalizeBinaryContent(
  item: McpToolContent,
  limits: McpToolResultLimits,
): NormalizedContentItem {
  const contentType = item.type as "image" | "audio";
  if (typeof item.data !== "string") {
    return invalidContent(contentType, "Missing base64 data string.");
  }

  const mimeType = optionalMetadata(item.mimeType, limits);
  const bytes = estimateBase64Bytes(item.data);

  return {
    item: {
      type: "binary",
      contentType,
      ...(mimeType === undefined ? {} : { mimeType }),
      ...(bytes === undefined ? {} : { bytes }),
      omitted: true,
    },
    modelText: `[MCP ${contentType} omitted${formatBinaryDetails(mimeType, bytes)}]`,
    naturalText: false,
    truncated: wasMetadataTruncated(item.mimeType, mimeType),
  };
}

function invalidContent(contentType: string, reason: string): NormalizedContentItem {
  return {
    item: { type: "invalid", contentType, reason },
    modelText: `[Invalid MCP ${contentType} content omitted: ${reason}]`,
    naturalText: false,
    truncated: false,
  };
}

function normalizeStructuredContent(
  value: JsonObject | undefined,
  limits: McpToolResultLimits,
): { value?: JsonObject; preview: string; truncated: boolean } | undefined {
  if (value === undefined) {
    return undefined;
  }

  const serialized = serializePreview(value, limits.maxStructuredCharacters);
  if (!serialized) {
    return undefined;
  }

  return {
    ...(serialized.truncated ? {} : { value: structuredClone(value) }),
    preview: serialized.preview,
    truncated: serialized.truncated,
  };
}

function serializePreview(
  value: unknown,
  maxCharacters: number,
): { preview: string; truncated: boolean } | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const serialized = JSON.stringify(value, null, 2);
    if (serialized === undefined) {
      return undefined;
    }
    const preview = truncate(serialized, maxCharacters);
    return { preview: preview.value, truncated: preview.truncated };
  } catch {
    return { preview: "[Unserializable JSON value]", truncated: true };
  }
}

function optionalMetadata(value: unknown, limits: McpToolResultLimits): string | undefined {
  return typeof value === "string"
    ? truncate(value, limits.maxMetadataCharacters).value
    : undefined;
}

function wasMetadataTruncated(original: unknown, normalized: string | undefined): boolean {
  return typeof original === "string" && normalized !== original;
}

function formatBinaryDetails(mimeType: string | undefined, bytes: number | undefined): string {
  const details = [mimeType, bytes === undefined ? undefined : `${bytes} bytes`]
    .filter(Boolean)
    .join(", ");
  return details ? `: ${details}` : "";
}

function estimateBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function truncate(value: string, maxCharacters: number): { value: string; truncated: boolean } {
  if (value.length <= maxCharacters) {
    return { value, truncated: false };
  }
  if (maxCharacters === 1) {
    return { value: "…", truncated: true };
  }

  return { value: `${value.slice(0, maxCharacters - 1)}…`, truncated: true };
}

class CharacterBudget {
  private remaining: number;

  constructor(maxCharacters: number) {
    this.remaining = maxCharacters;
  }

  take(value: string): { value: string; truncated: boolean } {
    if (this.remaining === 0) {
      return { value: "", truncated: value.length > 0 };
    }

    const result = truncate(value, this.remaining);
    this.remaining = Math.max(0, this.remaining - result.value.length);
    return result;
  }
}
