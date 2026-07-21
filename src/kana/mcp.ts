import { createNoopLogger, type Logger } from "@/logging";
import {
  McpClient,
  type McpImplementation,
  type McpManagedClient,
  McpManager,
  type McpManagerProgressEvent,
  type McpOAuthHttpAuthorizer,
  type McpOAuthHttpDiagnosticEvent,
  type McpServerRegistration,
  type McpTransport,
  StdioTransport,
  StreamableHttpTransport,
} from "@/mcp";
import type { OAuthFetch, OAuthTokenStore } from "@/oauth";
import { KANA_VERSION } from "../version";
import { createHttpProxyFetch } from "./http-proxy";
import type { KanaMcpConfig, KanaMcpServerConfig, KanaMcpStdioServerConfig } from "./mcp-config";
import { createKanaMcpOAuthAuthorizer } from "./mcp-oauth";
import { openKanaOAuthAuthorizationUrl } from "./oauth-browser";
import { createKanaOAuthTokenStore } from "./oauth-token-store";

const DEFAULT_CLIENT_INFO: McpImplementation = {
  name: "kana",
  version: KANA_VERSION,
};
const BASE_ENVIRONMENT_NAMES = [
  "HOME",
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
] as const;
const MAX_LOGGED_STDERR_CHARS = 16_000;

export type CreateKanaMcpManagerOptions = {
  enabledServerIds: Iterable<string>;
  env?: NodeJS.ProcessEnv;
  reservedToolNames?: Iterable<string>;
  getLogger?: () => Logger;
  clientInfo?: McpImplementation;
  oauthFetch?: OAuthFetch;
  oauthTokenStore?: OAuthTokenStore;
  openOAuthAuthorizationUrl?(serverId: string, url: string): Promise<void>;
  onOAuthDiagnostic?(serverId: string, event: McpOAuthHttpDiagnosticEvent): void;
  onProgress?(event: McpManagerProgressEvent): void;
};

export function createKanaMcpManager(
  config: KanaMcpConfig,
  options: CreateKanaMcpManagerOptions,
): McpManager {
  const env = { ...(options.env ?? process.env) };
  const clientInfo = { ...(options.clientInfo ?? DEFAULT_CLIENT_INFO) };
  const getLogger = options.getLogger ?? createNoopLogger;
  const oauthTokenStore = options.oauthTokenStore ?? createKanaOAuthTokenStore({ env, getLogger });
  const openOAuthAuthorizationUrl =
    options.openOAuthAuthorizationUrl ??
    ((_serverId: string, url: string) => openKanaOAuthAuthorizationUrl(url, { getLogger }));
  const enabledServerIds = new Set(options.enabledServerIds);
  const servers = Object.entries(config.mcpServers)
    .filter(([serverId]) => enabledServerIds.has(serverId))
    .map(([serverId, server]) =>
      createRegistration(serverId, copyServerConfig(server), {
        env,
        clientInfo,
        getLogger,
        oauthTokenStore,
        openOAuthAuthorizationUrl,
        ...(options.oauthFetch === undefined ? {} : { oauthFetch: options.oauthFetch }),
        ...(options.onOAuthDiagnostic === undefined
          ? {}
          : { onOAuthDiagnostic: options.onOAuthDiagnostic }),
      }),
    );

  return new McpManager({
    servers,
    reservedToolNames: options.reservedToolNames,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    onError: ({ serverId, phase, error }) => {
      getLogger().warn(phase === "start" ? "mcp.server_start_failed" : "mcp.server_close_failed", {
        serverId,
        error,
      });
    },
  });
}

type RegistrationContext = {
  env: NodeJS.ProcessEnv;
  clientInfo: McpImplementation;
  getLogger: () => Logger;
  oauthFetch?: OAuthFetch;
  oauthTokenStore: OAuthTokenStore;
  openOAuthAuthorizationUrl(serverId: string, url: string): Promise<void>;
  onOAuthDiagnostic?(serverId: string, event: McpOAuthHttpDiagnosticEvent): void;
};

function createRegistration(
  serverId: string,
  config: KanaMcpServerConfig,
  context: RegistrationContext,
): McpServerRegistration {
  return {
    id: serverId,
    required: config.required,
    ...(config.includeTools === undefined ? {} : { includeTools: config.includeTools }),
    ...(config.excludeTools === undefined ? {} : { excludeTools: config.excludeTools }),
    createClient() {
      const { transport, authorizer } = createTransport(serverId, config, context);

      const client = new McpClient({
        transport,
        clientInfo: context.clientInfo,
        initializeTimeoutMs: config.startupTimeoutMs,
        requestTimeoutMs: config.requestTimeoutMs,
        onError: (error) => {
          context.getLogger().warn("mcp.client_error", { serverId, error });
        },
        onTransportReconnect: (event) => {
          context.getLogger().info("mcp.transport_reconnected", { serverId, ...event });
        },
        onNotification: (notification) => {
          if (notification.method === "notifications/tools/list_changed") {
            context.getLogger().debug("mcp.tools_list_changed_ignored", { serverId });
          }
        },
      });
      if (authorizer === undefined) {
        return client;
      }

      let closePromise: Promise<void> | undefined;
      const managedClient: McpManagedClient = {
        get serverInfo() {
          return client.serverInfo;
        },
        get serverCapabilities() {
          return client.serverCapabilities;
        },
        async connect() {
          await authorizer.prepare();
          return client.connect();
        },
        listTools: client.listTools.bind(client),
        callTool: client.callTool.bind(client),
        close() {
          authorizer.beginClose();
          closePromise ??= client.close().finally(() => authorizer.close());
          return closePromise;
        },
      };
      return managedClient;
    },
  };
}

type CreatedTransport = {
  transport: McpTransport;
  authorizer?: McpOAuthHttpAuthorizer;
};

function createTransport(
  serverId: string,
  config: KanaMcpServerConfig,
  context: RegistrationContext,
): CreatedTransport {
  if (config.type === "http") {
    const authorizer =
      config.auth === undefined
        ? undefined
        : createKanaMcpOAuthAuthorizer(
            serverId,
            { ...config, auth: config.auth },
            {
              env: context.env,
              getLogger: context.getLogger,
              tokenStore: context.oauthTokenStore,
              openAuthorizationUrl: (url) => context.openOAuthAuthorizationUrl(serverId, url),
              ...(context.oauthFetch === undefined ? {} : { fetch: context.oauthFetch }),
              ...(context.onOAuthDiagnostic === undefined
                ? {}
                : {
                    onDiagnostic: (event) => context.onOAuthDiagnostic?.(serverId, event),
                  }),
            },
          );
    const transportFetch =
      authorizer?.fetch ??
      (config.proxy === undefined
        ? undefined
        : createHttpProxyFetch(config.proxy, context.oauthFetch ?? globalThis.fetch));
    if (config.proxy !== undefined) {
      try {
        context
          .getLogger()
          .debug(config.proxy === false ? "mcp.http_proxy_bypassed" : "mcp.http_proxy_enabled", {
            serverId,
          });
      } catch {
        // Diagnostic logging cannot prevent a configured server from starting.
      }
    }
    return {
      transport: new StreamableHttpTransport({
        url: config.url,
        headers: config.headers,
        ...(transportFetch === undefined ? {} : { fetch: transportFetch }),
      }),
      ...(authorizer === undefined ? {} : { authorizer }),
    };
  }

  return {
    transport: new StdioTransport({
      command: config.command,
      args: config.args,
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      env: createChildEnvironment(context.env, config.env),
      onStderr: createStderrLogger(serverId, context.getLogger),
    }),
  };
}

function createChildEnvironment(
  env: NodeJS.ProcessEnv,
  configured: Readonly<Record<string, string>>,
): Record<string, string> {
  const entries: Array<[string, string]> = [];

  for (const name of BASE_ENVIRONMENT_NAMES) {
    const value = env[name];
    if (value !== undefined) {
      entries.push([name, value]);
    }
  }

  return {
    ...Object.fromEntries(entries),
    ...configured,
  };
}

function createStderrLogger(serverId: string, getLogger: () => Logger): (content: string) => void {
  let remaining = MAX_LOGGED_STDERR_CHARS;
  let truncationReported = false;

  return (content) => {
    let loggedLength = 0;
    if (remaining > 0) {
      const logged = content.slice(0, remaining);
      loggedLength = logged.length;
      remaining -= logged.length;
      if (logged) {
        getLogger().debug("mcp.server_stderr", { serverId, content: logged });
      }
    }

    if (content.length > loggedLength && !truncationReported) {
      truncationReported = true;
      getLogger().debug("mcp.server_stderr_truncated", {
        serverId,
        maxChars: MAX_LOGGED_STDERR_CHARS,
      });
    }
  };
}

function copyServerConfig(config: KanaMcpServerConfig): KanaMcpServerConfig {
  if (config.type === "http") {
    return {
      ...config,
      headers: { ...config.headers },
      ...(config.auth === undefined
        ? {}
        : {
            auth: {
              ...config.auth,
              ...(config.auth.scopes === undefined ? {} : { scopes: config.auth.scopes.slice() }),
              authorizationParameters: { ...config.auth.authorizationParameters },
            },
          }),
      ...(config.includeTools === undefined ? {} : { includeTools: config.includeTools.slice() }),
      ...(config.excludeTools === undefined ? {} : { excludeTools: config.excludeTools.slice() }),
    };
  }

  return copyStdioConfig(config);
}

function copyStdioConfig(config: KanaMcpStdioServerConfig): KanaMcpStdioServerConfig {
  return {
    ...config,
    args: config.args.slice(),
    env: { ...config.env },
    ...(config.includeTools === undefined ? {} : { includeTools: config.includeTools.slice() }),
    ...(config.excludeTools === undefined ? {} : { excludeTools: config.excludeTools.slice() }),
  };
}
