import { createNoopLogger, type Logger } from "@/logging";
import {
  McpClient,
  type McpImplementation,
  type McpManagedClient,
  McpManager,
  type McpManagerProgressEvent,
  type McpOAuthClientStore,
  type McpOAuthHttpAuthorizer,
  type McpOAuthHttpDiagnosticEvent,
  type McpServerRegistration,
  type McpTransport,
  StdioClientTransport,
  StreamableHTTPClientTransport,
} from "@/mcp";
import type { OAuthFetch, OAuthTokenStore } from "@/oauth";
import { KANA_VERSION } from "@/version";
import { openKanaOAuthAuthorizationUrl } from "../auth/browser";
import { createKanaOAuthTokenStore } from "../auth/token-store";
import type { KanaMcpConfig, KanaMcpServerConfig, KanaMcpStdioServerConfig } from "./config";
import { createHttpProxyFetch } from "./http-proxy";
import { createKanaMcpOAuthAuthorizer } from "./oauth";

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
const ENVIRONMENT_PLACEHOLDER_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^{}]*))?\}/g;

export type CreateKanaMcpManagerOptions = {
  enabledServerIds: Iterable<string>;
  env?: NodeJS.ProcessEnv;
  getLogger?: () => Logger;
  clientInfo?: McpImplementation;
  oauthFetch?: OAuthFetch;
  oauthTokenStore?: OAuthTokenStore;
  oauthClientStore?: McpOAuthClientStore;
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
  const credentialStore = createKanaOAuthTokenStore({ env, getLogger });
  const oauthTokenStore = options.oauthTokenStore ?? credentialStore;
  const oauthClientStore = options.oauthClientStore ?? credentialStore;
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
        oauthClientStore,
        openOAuthAuthorizationUrl,
        ...(options.oauthFetch === undefined ? {} : { oauthFetch: options.oauthFetch }),
        ...(options.onOAuthDiagnostic === undefined
          ? {}
          : { onOAuthDiagnostic: options.onOAuthDiagnostic }),
      }),
    );

  return new McpManager({
    servers,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    onError: ({ serverId, phase, error }) => {
      getLogger().warn(phase === "start" ? "mcp.server_start_failed" : "mcp.server_close_failed", {
        serverId,
        errorType: error.name,
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
  oauthClientStore: McpOAuthClientStore;
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
    ...(config.description === undefined ? {} : { description: config.description }),
    required: config.required,
    ...(config.includeTools === undefined ? {} : { includeTools: config.includeTools }),
    ...(config.excludeTools === undefined ? {} : { excludeTools: config.excludeTools }),
    createClient(options = {}) {
      const { transport, authorizer } = createTransport(serverId, config, context, options.signal);

      const client = new McpClient({
        transport,
        clientInfo: context.clientInfo,
        initializeTimeoutMs: config.startupTimeoutMs,
        requestTimeoutMs: config.requestTimeoutMs,
        onError: (error) => {
          context.getLogger().warn("mcp.client_error", { serverId, errorType: error.name });
        },
        onToolsChanged: () => {
          context.getLogger().debug("mcp.tools_list_changed_ignored", { serverId });
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
        async connect(connectOptions) {
          await authorizer.prepare();
          return client.connect(connectOptions);
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
  signal?: AbortSignal,
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
              clientStore: context.oauthClientStore,
              openAuthorizationUrl: (url) => context.openOAuthAuthorizationUrl(serverId, url),
              ...(context.oauthFetch === undefined ? {} : { fetch: context.oauthFetch }),
              ...(signal === undefined ? {} : { signal }),
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
    const fetch = transportFetch ?? globalThis.fetch;
    return {
      transport: new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers },
        fetch: (input, init) =>
          fetch(
            input,
            init?.method === "DELETE"
              ? {
                  ...init,
                  signal: AbortSignal.any([
                    AbortSignal.timeout(5_000),
                    ...(init.signal ? [init.signal] : []),
                  ]),
                }
              : init,
          ),
      }),
      ...(authorizer === undefined ? {} : { authorizer }),
    };
  }

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    env: createChildEnvironment(serverId, context.env, config.env),
    stderr: "pipe",
  });
  const logStderr = createStderrLogger(serverId, context.getLogger);
  transport.stderr?.on("data", (content: Buffer) => logStderr(content.toString("utf8")));
  return { transport };
}

function createChildEnvironment(
  serverId: string,
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

  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(configured)) {
    resolved[key] = value.replace(
      ENVIRONMENT_PLACEHOLDER_PATTERN,
      (_placeholder, varName: string, fallback: string | undefined) => {
        const inherited = env[varName];
        // Follow shell `:-` semantics: a fallback applies when the inherited
        // variable is either unset or present with an empty value.
        if (inherited !== undefined && (fallback === undefined || inherited !== "")) {
          return inherited;
        }
        if (fallback !== undefined) {
          return fallback;
        }
        throw new Error(
          `MCP stdio server ${serverId} env.${key} references missing environment variable ${varName}.`,
        );
      },
    );
  }

  return {
    ...Object.fromEntries(entries),
    ...resolved,
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
