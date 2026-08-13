import type { OAuthFetch } from "@/oauth";
import { McpTransportError } from "./transport";

const DEFAULT_MAX_METADATA_BYTES = 256 * 1024;
const TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SAFE_ERROR_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;
const SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

export type McpAuthorizationChallengeKind = "authorization_required" | "insufficient_scope";

export type McpBearerChallenge = {
  resourceMetadataUrl?: string;
  scopes?: string[];
  error?: string;
};

export class McpAuthorizationChallengeError extends McpTransportError {
  constructor(
    public readonly status: 401 | 403,
    public readonly kind: McpAuthorizationChallengeKind,
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
  bearerMethodsSupported?: string[];
  resourceName?: string;
  resourceDocumentation?: string;
};

type McpProtectedResourceDiscoverySource = "challenge" | "path_well_known" | "root_well_known";

export type McpAuthorizationDiagnosticEvent =
  | {
      event: "mcp.authorization_metadata_discovery_attempted";
      level: "debug";
      attempt: number;
      source: McpProtectedResourceDiscoverySource;
    }
  | {
      event: "mcp.authorization_metadata_discovery_failed";
      level: "debug";
      attempt: number;
      source: McpProtectedResourceDiscoverySource;
      status?: number;
      errorIdentity?: string;
    }
  | {
      event: "mcp.authorization_metadata_discovery_succeeded";
      level: "info";
      attempt: number;
      source: McpProtectedResourceDiscoverySource;
      authorizationServerCount: number;
    };

type McpAuthorizationDiagnosticHandler = (event: McpAuthorizationDiagnosticEvent) => void;

export type DiscoverMcpProtectedResourceOptions = {
  challenge?: McpBearerChallenge;
  fetch?: OAuthFetch;
  maxResponseBytes?: number;
  onDiagnostic?: McpAuthorizationDiagnosticHandler;
  signal?: AbortSignal;
};

type MetadataCandidate = {
  source: McpProtectedResourceDiscoverySource;
  url: URL;
};

export function createMcpAuthorizationChallengeError(
  response: Response,
): McpAuthorizationChallengeError | undefined {
  if (response.status !== 401 && response.status !== 403) {
    return undefined;
  }

  const challenge = parseMcpBearerChallenge(response.headers.get("WWW-Authenticate"));
  if (response.status === 401) {
    return new McpAuthorizationChallengeError(401, "authorization_required", challenge ?? {});
  }
  if (challenge?.error === "insufficient_scope") {
    return new McpAuthorizationChallengeError(403, "insufficient_scope", challenge);
  }
  return undefined;
}

function parseMcpBearerChallenge(value: string | null): McpBearerChallenge | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }

  const challenges = groupAuthenticateChallenges(splitAuthenticateHeader(value));
  const bearer = challenges.find((challenge) => challenge.scheme.toLowerCase() === "bearer");
  if (bearer === undefined) {
    return undefined;
  }

  const parameters = new Map<string, string>();
  for (const item of bearer.parameters) {
    const [name, parameterValue] = parseAuthenticateParameter(item);
    const normalizedName = name.toLowerCase();
    if (parameters.has(normalizedName)) {
      throw new McpTransportError(
        `MCP WWW-Authenticate Bearer challenge repeated parameter ${normalizedName}.`,
      );
    }
    parameters.set(normalizedName, parameterValue);
  }

  const resourceMetadata = parameters.get("resource_metadata");
  const scope = parameters.get("scope");
  const error = parameters.get("error");
  return {
    ...(resourceMetadata === undefined
      ? {}
      : { resourceMetadataUrl: validateMetadataUrl(resourceMetadata).toString() }),
    ...(scope === undefined ? {} : { scopes: parseScopes(scope) }),
    ...(error === undefined || !SAFE_ERROR_PATTERN.test(error) ? {} : { error }),
  };
}

export async function discoverMcpProtectedResource(
  resource: string,
  options: DiscoverMcpProtectedResourceOptions = {},
): Promise<McpProtectedResourceMetadata> {
  assertPositiveInteger(options.maxResponseBytes, "maxResponseBytes");
  const canonicalResource = canonicalizeMcpResource(resource);
  const candidates = createProtectedResourceCandidates(canonicalResource, options.challenge);
  const fetch = options.fetch ?? globalThis.fetch;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_METADATA_BYTES;
  let lastFailure: unknown;

  for (const [index, candidate] of candidates.entries()) {
    throwIfAborted(options.signal);
    const attempt = index + 1;
    emitDiagnostic(options.onDiagnostic, {
      event: "mcp.authorization_metadata_discovery_attempted",
      level: "debug",
      attempt,
      source: candidate.source,
    });

    let response: Response;
    try {
      response = await fetch(candidate.url, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? error;
      }
      lastFailure = error;
      emitDiagnostic(options.onDiagnostic, {
        event: "mcp.authorization_metadata_discovery_failed",
        level: "debug",
        attempt,
        source: candidate.source,
        errorIdentity: describeErrorIdentity(error),
      });
      continue;
    }

    if (!response.ok) {
      lastFailure = new McpTransportError(
        `MCP protected resource metadata returned HTTP ${response.status}.`,
      );
      emitDiagnostic(options.onDiagnostic, {
        event: "mcp.authorization_metadata_discovery_failed",
        level: "debug",
        attempt,
        source: candidate.source,
        status: response.status,
      });
      await response.body?.cancel().catch(() => undefined);
      continue;
    }

    try {
      const value = await readBoundedJsonResponse(response, maxResponseBytes);
      const metadata = parseProtectedResourceMetadata(value, canonicalResource);
      emitDiagnostic(options.onDiagnostic, {
        event: "mcp.authorization_metadata_discovery_succeeded",
        level: "info",
        attempt,
        source: candidate.source,
        authorizationServerCount: metadata.authorizationServers.length,
      });
      return metadata;
    } catch (error) {
      lastFailure = error;
      emitDiagnostic(options.onDiagnostic, {
        event: "mcp.authorization_metadata_discovery_failed",
        level: "debug",
        attempt,
        source: candidate.source,
        errorIdentity: describeErrorIdentity(error),
      });
    }
  }

  throw new McpTransportError(
    `MCP protected resource metadata discovery failed after ${candidates.length} attempts.`,
    lastFailure === undefined ? undefined : { cause: lastFailure },
  );
}

export function selectMcpAuthorizationScopes(
  challenge: McpBearerChallenge | undefined,
  metadata: McpProtectedResourceMetadata,
): string[] | undefined {
  const scopes = challenge?.scopes ?? metadata.scopesSupported;
  return scopes?.slice();
}

export function canonicalizeMcpResource(value: string): string {
  let resource: URL;
  try {
    resource = new URL(value);
  } catch (error) {
    throw new McpTransportError("MCP OAuth resource must be an absolute URL.", { cause: error });
  }
  if (resource.protocol !== "https:") {
    throw new McpTransportError("MCP OAuth resource must use HTTPS.");
  }
  if (resource.username || resource.password) {
    throw new McpTransportError("MCP OAuth resource cannot contain credentials.");
  }
  if (resource.hash) {
    throw new McpTransportError("MCP OAuth resource cannot contain a fragment.");
  }

  return resource.pathname === "/" && !resource.search
    ? resource.origin
    : `${resource.origin}${resource.pathname}${resource.search}`;
}

function createProtectedResourceCandidates(
  resource: string,
  challenge: McpBearerChallenge | undefined,
): MetadataCandidate[] {
  if (challenge?.resourceMetadataUrl !== undefined) {
    return [{ source: "challenge", url: validateMetadataUrl(challenge.resourceMetadataUrl) }];
  }

  const resourceUrl = new URL(resource);
  const path = resourceUrl.pathname === "/" ? "" : resourceUrl.pathname;
  const candidates: MetadataCandidate[] = [];
  if (path !== "") {
    candidates.push({
      source: "path_well_known",
      url: new URL(`/.well-known/oauth-protected-resource${path}`, resourceUrl.origin),
    });
  }
  candidates.push({
    source: "root_well_known",
    url: new URL("/.well-known/oauth-protected-resource", resourceUrl.origin),
  });
  return candidates;
}

function parseProtectedResourceMetadata(
  value: unknown,
  expectedResource: string,
): McpProtectedResourceMetadata {
  if (!isJsonObject(value)) {
    throw new McpTransportError("MCP protected resource metadata must be a JSON object.");
  }

  const resource = readRequiredString(value, "resource");
  if (resource !== expectedResource) {
    throw new McpTransportError("MCP protected resource metadata resource does not match.");
  }
  const authorizationServers = readStringArray(value, "authorization_servers", true).map(
    validateAuthorizationServerIssuer,
  );
  const scopesSupported = readOptionalScopes(value, "scopes_supported");
  const bearerMethodsSupported = readOptionalStringArray(value, "bearer_methods_supported");
  if (bearerMethodsSupported !== undefined && !bearerMethodsSupported.includes("header")) {
    throw new McpTransportError(
      "MCP protected resource does not advertise Authorization header bearer tokens.",
    );
  }

  return {
    resource,
    authorizationServers,
    ...(scopesSupported === undefined ? {} : { scopesSupported }),
    ...(bearerMethodsSupported === undefined ? {} : { bearerMethodsSupported }),
    ...readOptionalString(value, "resource_name", "resourceName"),
    ...readOptionalHttpsUrl(value, "resource_documentation", "resourceDocumentation"),
  };
}

function validateAuthorizationServerIssuer(value: string): string {
  let issuer: URL;
  try {
    issuer = new URL(value);
  } catch (error) {
    throw new McpTransportError("MCP authorization server issuer must be an absolute URL.", {
      cause: error,
    });
  }
  if (issuer.protocol !== "https:") {
    throw new McpTransportError("MCP authorization server issuer must use HTTPS.");
  }
  if (issuer.username || issuer.password || issuer.search || issuer.hash) {
    throw new McpTransportError(
      "MCP authorization server issuer cannot contain credentials, query, or fragment.",
    );
  }
  return value;
}

function validateMetadataUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new McpTransportError("MCP resource metadata location must be an absolute URL.", {
      cause: error,
    });
  }
  if (url.protocol !== "https:") {
    throw new McpTransportError("MCP resource metadata location must use HTTPS.");
  }
  if (url.username || url.password || url.hash) {
    throw new McpTransportError(
      "MCP resource metadata location cannot contain credentials or a fragment.",
    );
  }
  return url;
}

function splitAuthenticateHeader(value: string): string[] {
  const items: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === ",") {
      const item = value.slice(start, index).trim();
      if (item) {
        items.push(item);
      }
      start = index + 1;
    }
  }

  if (quoted || escaped) {
    throw new McpTransportError("MCP WWW-Authenticate header contains an invalid quoted string.");
  }
  const finalItem = value.slice(start).trim();
  if (finalItem) {
    items.push(finalItem);
  }
  return items;
}

function groupAuthenticateChallenges(
  items: string[],
): Array<{ scheme: string; parameters: string[] }> {
  const challenges: Array<{ scheme: string; parameters: string[] }> = [];
  for (const item of items) {
    const token = readLeadingToken(item);
    let offset = token.length;
    while (item[offset] === " " || item[offset] === "\t") {
      offset += 1;
    }

    if (item[offset] === "=") {
      const current = challenges.at(-1);
      if (current === undefined) {
        throw new McpTransportError("MCP WWW-Authenticate header starts with an auth parameter.");
      }
      current.parameters.push(item);
      continue;
    }

    if (offset === token.length && offset < item.length) {
      throw new McpTransportError("MCP WWW-Authenticate header contains an invalid challenge.");
    }
    const rest = item.slice(offset).trim();
    challenges.push({ scheme: token, parameters: rest ? [rest] : [] });
  }
  return challenges;
}

function parseAuthenticateParameter(value: string): [string, string] {
  const name = readLeadingToken(value);
  let offset = name.length;
  while (value[offset] === " " || value[offset] === "\t") {
    offset += 1;
  }
  if (value[offset] !== "=") {
    throw new McpTransportError("MCP Bearer challenge contains a non-parameter value.");
  }
  offset += 1;
  while (value[offset] === " " || value[offset] === "\t") {
    offset += 1;
  }

  const parameterValue = value.slice(offset).trim();
  if (parameterValue.startsWith('"')) {
    return [name, parseQuotedString(parameterValue)];
  }
  if (!TOKEN_PATTERN.test(parameterValue)) {
    throw new McpTransportError("MCP Bearer challenge contains an invalid parameter value.");
  }
  return [name, parameterValue];
}

function parseQuotedString(value: string): string {
  if (!value.endsWith('"') || value.length < 2) {
    throw new McpTransportError("MCP Bearer challenge contains an unterminated quoted value.");
  }

  let result = "";
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index]!;
    if (character === "\\") {
      index += 1;
      if (index >= value.length - 1) {
        throw new McpTransportError("MCP Bearer challenge contains an invalid escape.");
      }
      result += value[index]!;
      continue;
    }
    if (character === '"' || character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f) {
      throw new McpTransportError("MCP Bearer challenge contains an invalid quoted value.");
    }
    result += character;
  }
  return result;
}

function readLeadingToken(value: string): string {
  let length = 0;
  while (length < value.length && TOKEN_PATTERN.test(value[length]!)) {
    length += 1;
  }
  const token = value.slice(0, length);
  if (!token) {
    throw new McpTransportError("MCP WWW-Authenticate header contains an invalid token.");
  }
  return token;
}

function parseScopes(value: string): string[] {
  const scopes = value.split(" ").filter(Boolean);
  if (scopes.length === 0 || scopes.some((scope) => !SCOPE_TOKEN_PATTERN.test(scope))) {
    throw new McpTransportError("MCP Bearer challenge contains invalid scopes.");
  }
  return scopes;
}

function readOptionalScopes(value: Record<string, unknown>, key: string): string[] | undefined {
  const scopes = readOptionalStringArray(value, key);
  if (scopes?.some((scope) => !SCOPE_TOKEN_PATTERN.test(scope))) {
    throw new McpTransportError(`MCP protected resource metadata ${key} contains invalid scopes.`);
  }
  return scopes;
}

function readStringArray(
  value: Record<string, unknown>,
  key: string,
  requireNonEmpty: boolean,
): string[] {
  const candidate = value[key];
  if (
    !Array.isArray(candidate) ||
    (requireNonEmpty && candidate.length === 0) ||
    candidate.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new McpTransportError(
      `MCP protected resource metadata ${key} must be ${requireNonEmpty ? "a non-empty" : "a"} string array.`,
    );
  }
  return candidate.slice() as string[];
}

function readOptionalStringArray(
  value: Record<string, unknown>,
  key: string,
): string[] | undefined {
  if (value[key] === undefined) {
    return undefined;
  }
  return readStringArray(value, key, false);
}

function readRequiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new McpTransportError(
      `MCP protected resource metadata ${key} must be a non-empty string.`,
    );
  }
  return candidate;
}

function readOptionalString<TKey extends string>(
  value: Record<string, unknown>,
  sourceKey: string,
  targetKey: TKey,
): { [T in TKey]?: string } {
  const candidate = value[sourceKey];
  if (candidate === undefined) {
    return {};
  }
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new McpTransportError(
      `MCP protected resource metadata ${sourceKey} must be a non-empty string.`,
    );
  }
  return { [targetKey]: candidate } as { [T in TKey]?: string };
}

function readOptionalHttpsUrl<TKey extends string>(
  value: Record<string, unknown>,
  sourceKey: string,
  targetKey: TKey,
): { [T in TKey]?: string } {
  const optional = readOptionalString(value, sourceKey, targetKey);
  const candidate = optional[targetKey];
  if (candidate === undefined) {
    return {};
  }
  return { [targetKey]: validateMetadataUrl(candidate).toString() } as { [T in TKey]?: string };
}

async function readBoundedJsonResponse(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) {
    throw new McpTransportError("MCP protected resource metadata response has no body.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new McpTransportError(
          `MCP protected resource metadata exceeds the ${maxBytes}-byte limit.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new McpTransportError("MCP protected resource metadata returned invalid JSON.", {
      cause: error,
    });
  }
}

function describeErrorIdentity(error: unknown): string {
  if (!(error instanceof Error)) {
    return `thrown ${typeof error}`;
  }
  const code = (error as Error & { code?: unknown }).code;
  const safeCode =
    (typeof code === "string" || typeof code === "number") && SAFE_ERROR_PATTERN.test(String(code))
      ? String(code)
      : undefined;
  return safeCode === undefined
    ? error.name || "Error"
    : `${error.name || "Error"}, code ${safeCode}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("MCP authorization operation was aborted.");
  }
}

function assertPositiveInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emitDiagnostic(
  handler: McpAuthorizationDiagnosticHandler | undefined,
  event: McpAuthorizationDiagnosticEvent,
): void {
  try {
    handler?.(event);
  } catch {
    // Diagnostic consumers cannot alter authorization metadata discovery.
  }
}
