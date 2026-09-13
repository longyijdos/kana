import { type KanaOAuthTokenStatus, loadKanaOAuthTokenStatuses } from "../auth/token-store";
import {
  mergeConfigStringSet,
  readOptionalConfigFile,
  withLockedConfigFile,
  writeConfigFileAtomically,
} from "../config/file-storage";
import { getKanaConfigPaths } from "../path";
import { type KanaMcpConfig, loadKanaMcpConfig } from "./config";
import { createKanaMcpOAuthStorageKey } from "./oauth";

export type KanaMcpActivationState = {
  enabledServers: string[];
};

type KanaMcpServerActivationBase = {
  id: string;
  enabled: boolean;
};

export type KanaMcpServerActivation = KanaMcpServerActivationBase &
  (
    | {
        type: "stdio";
        command: string;
        args: string[];
      }
    | {
        type: "http";
        url: string;
        oauth?: KanaOAuthTokenStatus & { type: "oauth2" };
      }
  );

export const DEFAULT_KANA_MCP_ACTIVATION_STATE: KanaMcpActivationState = {
  enabledServers: [],
};

const ROOT_KEYS = new Set(["enabledServers"]);

export function loadKanaMcpActivationState(
  env: NodeJS.ProcessEnv = process.env,
): KanaMcpActivationState {
  const { mcpEnabledPath } = getKanaConfigPaths(env);
  const content = readOptionalConfigFile(mcpEnabledPath);
  if (content === undefined) {
    return { enabledServers: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to parse MCP activation state: ${mcpEnabledPath}`, { cause: error });
  }

  return parseKanaMcpActivationState(parsed);
}

export function loadKanaMcpServerActivations(
  env: NodeJS.ProcessEnv = process.env,
): KanaMcpServerActivation[] {
  const config = loadKanaMcpConfig(env);
  const activationState = loadKanaMcpActivationState(env);
  return resolveKanaMcpServerActivations(config, activationState, env);
}

export function resolveKanaMcpServerActivations(
  config: KanaMcpConfig,
  activationState: KanaMcpActivationState,
  env: NodeJS.ProcessEnv = process.env,
): KanaMcpServerActivation[] {
  const enabledServerIds = new Set(activationState.enabledServers);
  const oauthServerIds = Object.entries(config.mcpServers)
    .filter(([, server]) => server.type === "http" && server.auth !== undefined)
    .map(([id]) => id);
  const oauthStatuses = loadKanaOAuthTokenStatuses(
    oauthServerIds.map(createKanaMcpOAuthStorageKey),
    { env },
  );

  return Object.entries(config.mcpServers).map(([id, server]) =>
    server.type === "http"
      ? {
          id,
          type: "http",
          url: server.url,
          enabled: enabledServerIds.has(id),
          ...(server.auth === undefined
            ? {}
            : {
                oauth: {
                  type: "oauth2" as const,
                  ...oauthStatuses[createKanaMcpOAuthStorageKey(id)]!,
                },
              }),
        }
      : {
          id,
          type: "stdio",
          command: server.command,
          args: server.args.slice(),
          enabled: enabledServerIds.has(id),
        },
  );
}

export function parseKanaMcpActivationState(value: unknown): KanaMcpActivationState {
  const root = asRecord(value, "MCP activation state");
  assertKnownKeys(root, ROOT_KEYS, "MCP activation state");
  const enabledServers = root.enabledServers ?? [];

  if (!Array.isArray(enabledServers)) {
    throw new Error("MCP activation state.enabledServers must be an array of server IDs.");
  }

  const parsedServerIds = enabledServers.map((serverId, index) => {
    if (typeof serverId !== "string" || !serverId.trim()) {
      throw new Error(`MCP activation state.enabledServers[${index}] must be a non-empty string.`);
    }
    return serverId;
  });

  if (new Set(parsedServerIds).size !== parsedServerIds.length) {
    throw new Error("MCP activation state.enabledServers cannot contain duplicate server IDs.");
  }

  return { enabledServers: parsedServerIds };
}

export function saveKanaMcpActivationState(
  state: KanaMcpActivationState,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const previous = loadKanaMcpActivationState(env);
  persistKanaMcpActivationState(previous, state, env);
}

export function persistKanaMcpActivationState(
  previousSnapshot: KanaMcpActivationState,
  nextSnapshot: KanaMcpActivationState,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const parsed = parseKanaMcpActivationState(nextSnapshot);
  const { mcpEnabledPath } = getKanaConfigPaths(env);

  withLockedConfigFile(mcpEnabledPath, () => {
    const persisted = loadKanaMcpActivationState(env);
    const enabledServers = mergeConfigStringSet(
      persisted.enabledServers,
      previousSnapshot.enabledServers,
      parsed.enabledServers,
    );
    writeConfigFileAtomically(mcpEnabledPath, `${JSON.stringify({ enabledServers }, null, 2)}\n`);
  });
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  name: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new Error(`${name} contains unknown field ${unknown}.`);
  }
}
