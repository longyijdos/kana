import { createNoopLogger, type Logger } from "@/logging";
import {
  McpClient,
  type McpImplementation,
  McpManager,
  type McpManagerProgressEvent,
  type McpServerRegistration,
  type McpTransport,
  StdioTransport,
  StreamableHttpTransport,
} from "@/mcp";
import { KANA_VERSION } from "../version";
import type { KanaMcpConfig, KanaMcpServerConfig, KanaMcpStdioServerConfig } from "./mcp-config";

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
  onProgress?(event: McpManagerProgressEvent): void;
};

export function createKanaMcpManager(
  config: KanaMcpConfig,
  options: CreateKanaMcpManagerOptions,
): McpManager {
  const env = { ...(options.env ?? process.env) };
  const clientInfo = { ...(options.clientInfo ?? DEFAULT_CLIENT_INFO) };
  const getLogger = options.getLogger ?? createNoopLogger;
  const enabledServerIds = new Set(options.enabledServerIds);
  const servers = Object.entries(config.mcpServers)
    .filter(([serverId]) => enabledServerIds.has(serverId))
    .map(([serverId, server]) =>
      createRegistration(serverId, copyServerConfig(server), {
        env,
        clientInfo,
        getLogger,
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
      const transport = createTransport(serverId, config, context);

      return new McpClient({
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
    },
  };
}

function createTransport(
  serverId: string,
  config: KanaMcpServerConfig,
  context: RegistrationContext,
): McpTransport {
  if (config.type === "http") {
    return new StreamableHttpTransport({
      url: config.url,
      headers: config.headers,
    });
  }

  return new StdioTransport({
    command: config.command,
    args: config.args,
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    env: createChildEnvironment(context.env, config.env),
    onStderr: createStderrLogger(serverId, context.getLogger),
  });
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
