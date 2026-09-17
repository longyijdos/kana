import {
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams,
} from "@modelcontextprotocol/client";
import type { OAuthFetch } from "@/oauth";
import { McpAuthorizationError } from "./errors";

export type McpBearerChallenge = {
  resourceMetadataUrl?: string;
  scopes?: string[];
  error?: string;
};

export class McpAuthorizationChallengeError extends McpAuthorizationError {
  constructor(
    public readonly status: 401 | 403,
    public readonly kind: "authorization_required" | "insufficient_scope",
    public readonly challenge: McpBearerChallenge,
    message = kind === "authorization_required"
      ? "MCP HTTP authorization is required."
      : "MCP HTTP authorization requires additional scopes.",
  ) {
    super(message);
    this.name = "McpAuthorizationChallengeError";
  }
}

export type McpProtectedResourceMetadata = {
  resource: string;
  authorizationServers: string[];
  scopesSupported?: string[];
};

export type McpAuthorizationDiagnosticEvent =
  | { event: "mcp.authorization_metadata_discovery_attempted"; level: "debug"; attempt: number }
  | { event: "mcp.authorization_metadata_discovery_failed"; level: "debug"; errorIdentity: string }
  | {
      event: "mcp.authorization_metadata_discovery_succeeded";
      level: "info";
      authorizationServerCount: number;
    };

export function createMcpAuthorizationChallengeError(
  response: Response,
): McpAuthorizationChallengeError | undefined {
  if (response.status !== 401 && response.status !== 403) return undefined;
  const parsed = extractWWWAuthenticateParams(response);
  if (response.status === 403 && parsed.error !== "insufficient_scope") return undefined;
  const challenge: McpBearerChallenge = {
    ...(parsed.resourceMetadataUrl === undefined
      ? {}
      : { resourceMetadataUrl: parsed.resourceMetadataUrl.href }),
    ...(parsed.scope === undefined ? {} : { scopes: parsed.scope.split(/\s+/).filter(Boolean) }),
    ...(parsed.error === undefined ? {} : { error: parsed.error }),
  };
  return new McpAuthorizationChallengeError(
    response.status,
    response.status === 401 ? "authorization_required" : "insufficient_scope",
    challenge,
  );
}

export async function discoverMcpProtectedResource(
  resource: string,
  options: {
    challenge?: McpBearerChallenge;
    fetch?: OAuthFetch;
    signal?: AbortSignal;
    onDiagnostic?(event: McpAuthorizationDiagnosticEvent): void;
  } = {},
): Promise<McpProtectedResourceMetadata> {
  const canonical = canonicalizeMcpResource(resource);
  const fetch = options.fetch ?? globalThis.fetch;
  let attempt = 0;
  try {
    const metadata = await discoverOAuthProtectedResourceMetadata(
      canonical,
      {
        resourceMetadataUrl: options.challenge?.resourceMetadataUrl,
      },
      (input, init) => {
        options.onDiagnostic?.({
          event: "mcp.authorization_metadata_discovery_attempted",
          level: "debug",
          attempt: ++attempt,
        });
        return fetch(input, { ...init, signal: options.signal ?? init?.signal });
      },
    );
    if (canonicalizeMcpResource(metadata.resource) !== canonical) {
      throw new McpAuthorizationError(
        "MCP protected resource metadata does not match the configured resource.",
      );
    }
    if (!metadata.authorization_servers?.length) {
      throw new McpAuthorizationError(
        "MCP protected resource metadata did not provide an authorization server.",
      );
    }
    if (
      metadata.bearer_methods_supported &&
      !metadata.bearer_methods_supported.includes("header")
    ) {
      throw new McpAuthorizationError("MCP OAuth requires Authorization-header Bearer tokens.");
    }
    options.onDiagnostic?.({
      event: "mcp.authorization_metadata_discovery_succeeded",
      level: "info",
      authorizationServerCount: metadata.authorization_servers.length,
    });
    return {
      resource: canonical,
      authorizationServers: metadata.authorization_servers,
      ...(metadata.scopes_supported === undefined
        ? {}
        : { scopesSupported: metadata.scopes_supported }),
    };
  } catch (error) {
    options.onDiagnostic?.({
      event: "mcp.authorization_metadata_discovery_failed",
      level: "debug",
      errorIdentity: error instanceof Error ? error.name : "Error",
    });
    throw error;
  }
}

export function canonicalizeMcpResource(value: string): string {
  const resource = new URL(value);
  if (resource.protocol !== "https:" || resource.username || resource.password || resource.hash) {
    throw new McpAuthorizationError(
      "MCP OAuth resource must use HTTPS without credentials or a fragment.",
    );
  }
  return resource.pathname === "/" && !resource.search
    ? resource.origin
    : `${resource.origin}${resource.pathname}${resource.search}`;
}
