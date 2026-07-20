import { createHash } from "node:crypto";

const MAX_PROVIDER_TOOL_NAME_LENGTH = 64;
const MAX_SERVER_SLUG_LENGTH = 16;
const HASH_LENGTH = 10;

export function createMcpToolAlias(serverId: string, remoteToolName: string): string {
  const serverSlug = createSlug(serverId, "server").slice(0, MAX_SERVER_SLUG_LENGTH);
  const toolSlug = createSlug(remoteToolName, "tool");
  const hash = createHash("sha256")
    .update(serverId)
    .update("\0")
    .update(remoteToolName)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  const prefix = `mcp_${serverSlug}_`;
  const suffix = `_${hash}`;
  const toolBudget = MAX_PROVIDER_TOOL_NAME_LENGTH - prefix.length - suffix.length;
  const readableTool = toolSlug.slice(0, Math.max(1, toolBudget));

  return `${prefix}${readableTool}${suffix}`;
}

function createSlug(value: string, fallback: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

  return slug || fallback;
}
