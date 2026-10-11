import { Type } from "typebox";
import type { OAuthTokenStatus } from "@/oauth";
import { nonEmptyString, parseWithSchema, strictObject } from "@/utils";
import { loadKanaOAuthTokenStatuses } from "../auth/token-store";
import {
  mergeConfigStringSet,
  readOptionalConfigFile,
  withLockedConfigFile,
  writeConfigFileAtomically,
} from "../config/file-storage";
import { getKanaConfigPaths } from "../path";
import type { KanaMcpConfig } from "./config";
import { createKanaMcpOAuthStorageKey } from "./oauth";

export type KanaMcpActivationState = {
  readonly enabledServers: readonly string[];
};

type KanaMcpServerActivationBase = {
  readonly id: string;
  readonly enabled: boolean;
};

export type KanaMcpServerActivation = KanaMcpServerActivationBase &
  (
    | {
        readonly type: "stdio";
        readonly command: string;
        readonly args: readonly string[];
      }
    | {
        readonly type: "http";
        readonly url: string;
        readonly oauth?: OAuthTokenStatus & { type: "oauth2" };
      }
  );

const ACTIVATION_STATE_SCHEMA = strictObject({
  enabledServers: Type.Optional(Type.Array(nonEmptyString(), { uniqueItems: true })),
});

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
          args: server.args,
          enabled: enabledServerIds.has(id),
        },
  );
}

export function parseKanaMcpActivationState(value: unknown): KanaMcpActivationState {
  const { enabledServers = [] } = parseWithSchema(
    ACTIVATION_STATE_SCHEMA,
    value,
    "MCP activation state",
  );
  return { enabledServers };
}

export function persistKanaMcpActivationState(
  previousSnapshot: KanaMcpActivationState,
  nextSnapshot: KanaMcpActivationState,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const { mcpEnabledPath } = getKanaConfigPaths(env);

  withLockedConfigFile(mcpEnabledPath, () => {
    const persisted = loadKanaMcpActivationState(env);
    const enabledServers = mergeConfigStringSet(
      persisted.enabledServers,
      previousSnapshot.enabledServers,
      nextSnapshot.enabledServers,
    );
    writeConfigFileAtomically(mcpEnabledPath, `${JSON.stringify({ enabledServers }, null, 2)}\n`);
  });
}
