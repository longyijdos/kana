import { createNoopLogger, type Logger } from "@/logging";
import {
  type McpOAuthClientStore,
  McpOAuthHttpAuthorizer,
  type McpOAuthHttpDiagnosticEvent,
} from "@/mcp";
import {
  getOAuthTokenStatus,
  type OAuthFetch,
  type OAuthTokenStatus,
  type OAuthTokenStore,
} from "@/oauth";
import { openKanaOAuthAuthorizationUrl } from "../auth/browser";
import { createKanaOAuthTokenStore } from "../auth/token-store";
import {
  type KanaMcpConfig,
  type KanaMcpHttpServerConfig,
  type KanaMcpOAuth2Config,
  loadKanaMcpConfig,
  resolveKanaMcpOAuth2Client,
} from "./config";
import { createHttpProxyFetch } from "./http-proxy";

type KanaMcpOAuthServerConfig = KanaMcpHttpServerConfig & {
  auth: KanaMcpOAuth2Config;
};

export type CreateKanaMcpOAuthAuthorizerOptions = {
  env: NodeJS.ProcessEnv;
  getLogger: () => Logger;
  tokenStore: OAuthTokenStore;
  clientStore: McpOAuthClientStore;
  openAuthorizationUrl(url: string): Promise<void>;
  fetch?: OAuthFetch;
  signal?: AbortSignal;
  onDiagnostic?(event: McpOAuthHttpDiagnosticEvent): void;
};

export type RunKanaMcpOAuthOptions = {
  env?: NodeJS.ProcessEnv;
  config?: KanaMcpConfig;
  getLogger?: () => Logger;
  tokenStore?: OAuthTokenStore;
  clientStore?: McpOAuthClientStore;
  openAuthorizationUrl?(url: string): Promise<void>;
  fetch?: OAuthFetch;
  signal?: AbortSignal;
  onDiagnostic?(event: McpOAuthHttpDiagnosticEvent): void;
};

export function createKanaMcpOAuthStorageKey(serverId: string): string {
  if (!serverId.trim()) {
    throw new Error("MCP server ID cannot be empty.");
  }
  return `mcp:${serverId}`;
}

export function createKanaMcpOAuthAuthorizer(
  serverId: string,
  config: KanaMcpOAuthServerConfig,
  options: CreateKanaMcpOAuthAuthorizerOptions,
): McpOAuthHttpAuthorizer {
  const fetch =
    config.proxy === undefined
      ? options.fetch
      : createHttpProxyFetch(config.proxy, options.fetch ?? globalThis.fetch);

  return new McpOAuthHttpAuthorizer({
    resource: config.url,
    storageKey: createKanaMcpOAuthStorageKey(serverId),
    client: resolveKanaMcpOAuth2Client(config.auth, options.env),
    tokenStore: options.tokenStore,
    clientStore: options.clientStore,
    openAuthorizationUrl: options.openAuthorizationUrl,
    ...(config.auth.redirectUri === undefined ? {} : { redirectUri: config.auth.redirectUri }),
    ...(config.auth.scopes === undefined ? {} : { scopes: config.auth.scopes }),
    additionalAuthorizationParameters: config.auth.authorizationParameters,
    callbackTimeoutMs: config.auth.callbackTimeoutMs,
    ...(fetch === undefined ? {} : { fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onDiagnostic: createDiagnosticHandler(serverId, options),
  });
}

export async function authorizeKanaMcpServer(
  serverId: string,
  options: RunKanaMcpOAuthOptions = {},
): Promise<OAuthTokenStatus> {
  const context = createOperationContext(options);
  const server = requireOAuthServer(serverId, context.env, options.config);
  const authorizer = createKanaMcpOAuthAuthorizer(serverId, server, {
    ...context,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
  });

  try {
    await authorizer.authorize();
  } finally {
    authorizer.close();
  }

  const token = await context.tokenStore.load(createKanaMcpOAuthStorageKey(serverId));
  if (token === undefined) {
    throw new Error(`MCP server ${serverId} completed OAuth without storing credentials.`);
  }
  return getOAuthTokenStatus(token);
}

export async function signOutKanaMcpServer(
  serverId: string,
  options: RunKanaMcpOAuthOptions = {},
): Promise<OAuthTokenStatus> {
  const context = createOperationContext(options);
  requireOAuthServer(serverId, context.env, options.config);
  await context.tokenStore.delete(createKanaMcpOAuthStorageKey(serverId));
  await context.clientStore.deleteClient(createKanaMcpOAuthStorageKey(serverId));
  context.getLogger().info("mcp.oauth_signed_out", { serverId });
  return getOAuthTokenStatus(undefined);
}

function createOperationContext(options: RunKanaMcpOAuthOptions): {
  env: NodeJS.ProcessEnv;
  getLogger: () => Logger;
  tokenStore: OAuthTokenStore;
  clientStore: McpOAuthClientStore;
  openAuthorizationUrl(url: string): Promise<void>;
} {
  const env = { ...(options.env ?? process.env) };
  const getLogger = options.getLogger ?? createNoopLogger;
  const store = createKanaOAuthTokenStore({ env, getLogger });
  return {
    env,
    getLogger,
    tokenStore: options.tokenStore ?? store,
    clientStore: options.clientStore ?? store,
    openAuthorizationUrl:
      options.openAuthorizationUrl ??
      ((url: string) => openKanaOAuthAuthorizationUrl(url, { getLogger })),
  };
}

function requireOAuthServer(
  serverId: string,
  env: NodeJS.ProcessEnv,
  config?: KanaMcpConfig,
): KanaMcpOAuthServerConfig {
  const server = (config ?? loadKanaMcpConfig(env)).mcpServers[serverId];
  if (server === undefined) {
    throw new Error(`MCP server ${serverId} is not configured.`);
  }
  if (server.type !== "http" || server.auth === undefined) {
    throw new Error(`MCP server ${serverId} does not use OAuth.`);
  }
  return server as KanaMcpOAuthServerConfig;
}

function createDiagnosticHandler(
  serverId: string,
  options: Pick<CreateKanaMcpOAuthAuthorizerOptions, "getLogger" | "onDiagnostic">,
): (event: McpOAuthHttpDiagnosticEvent) => void {
  return (diagnostic) => {
    const { event, level, ...metadata } = diagnostic;
    options.getLogger()[level](event, { serverId, ...metadata });
    try {
      options.onDiagnostic?.(diagnostic);
    } catch {
      // Presentation callbacks cannot change authorization control flow.
    }
  };
}
