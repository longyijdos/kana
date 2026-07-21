import { OAuthDiscoveryError, OAuthProtocolError } from "./errors";
import {
  assertOAuthMaxResponseBytes,
  DEFAULT_OAUTH_MAX_RESPONSE_BYTES,
  describeOAuthErrorIdentity,
  readOAuthJsonResponse,
} from "./http";
import type {
  OAuthAuthorizationServerMetadata,
  OAuthDiagnosticHandler,
  OAuthDiscoveryMethod,
  OAuthFetch,
} from "./types";

export type OAuthAuthorizationServerDiscoveryOptions = {
  fetch?: OAuthFetch;
  maxResponseBytes?: number;
  onDiagnostic?: OAuthDiagnosticHandler;
  signal?: AbortSignal;
};

type MetadataCandidate = {
  method: OAuthDiscoveryMethod;
  url: URL;
};

export async function discoverOAuthAuthorizationServer(
  issuer: string,
  options: OAuthAuthorizationServerDiscoveryOptions = {},
): Promise<OAuthAuthorizationServerMetadata> {
  assertOAuthMaxResponseBytes(options.maxResponseBytes);
  const candidates = createMetadataCandidates(issuer);
  const fetch = options.fetch ?? globalThis.fetch;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_OAUTH_MAX_RESPONSE_BYTES;
  let lastFailure: unknown;

  for (const [index, candidate] of candidates.entries()) {
    throwIfAborted(options.signal);
    const attempt = index + 1;
    emitDiagnostic(options.onDiagnostic, {
      event: "oauth.metadata_discovery_attempted",
      level: "debug",
      attempt,
      method: candidate.method,
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
        event: "oauth.metadata_discovery_failed",
        level: "debug",
        attempt,
        method: candidate.method,
        errorIdentity: describeOAuthErrorIdentity(error),
      });
      continue;
    }

    if (!response.ok) {
      lastFailure = new OAuthDiscoveryError(
        `OAuth metadata discovery attempt returned HTTP ${response.status}.`,
      );
      emitDiagnostic(options.onDiagnostic, {
        event: "oauth.metadata_discovery_failed",
        level: "debug",
        attempt,
        method: candidate.method,
        status: response.status,
      });
      await response.body?.cancel().catch(() => undefined);
      continue;
    }

    try {
      const value = await readOAuthJsonResponse(response, maxResponseBytes);
      const metadata = parseAuthorizationServerMetadata(value, issuer);
      emitDiagnostic(options.onDiagnostic, {
        event: "oauth.metadata_discovery_succeeded",
        level: "info",
        attempt,
        method: candidate.method,
      });
      return metadata;
    } catch (error) {
      lastFailure = error;
      emitDiagnostic(options.onDiagnostic, {
        event: "oauth.metadata_discovery_failed",
        level: "debug",
        attempt,
        method: candidate.method,
        errorIdentity: describeOAuthErrorIdentity(error),
      });
    }
  }

  throw new OAuthDiscoveryError(
    `OAuth authorization server metadata discovery failed after ${candidates.length} attempts.`,
    lastFailure === undefined ? undefined : { cause: lastFailure },
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("OAuth operation was aborted.");
  }
}

function createMetadataCandidates(issuer: string): MetadataCandidate[] {
  const issuerUrl = parseHttpsUrl(issuer, "OAuth authorization server issuer");
  if (issuerUrl.search || issuerUrl.hash) {
    throw new OAuthDiscoveryError(
      "OAuth authorization server issuer cannot contain query or hash.",
    );
  }

  const issuerPath = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname.replace(/\/$/, "");
  const candidates: MetadataCandidate[] = [
    {
      method: "oauth_authorization_server",
      url: createWellKnownUrl(issuerUrl, `/.well-known/oauth-authorization-server${issuerPath}`),
    },
    {
      method: "openid_configuration",
      url: createWellKnownUrl(issuerUrl, `/.well-known/openid-configuration${issuerPath}`),
    },
  ];

  if (issuerPath !== "") {
    candidates.push({
      method: "openid_configuration",
      url: createWellKnownUrl(issuerUrl, `${issuerPath}/.well-known/openid-configuration`),
    });
  }

  return candidates;
}

function createWellKnownUrl(issuer: URL, pathname: string): URL {
  const result = new URL(issuer.origin);
  result.pathname = pathname;
  return result;
}

function parseAuthorizationServerMetadata(
  value: unknown,
  expectedIssuer: string,
): OAuthAuthorizationServerMetadata {
  if (!isJsonObject(value)) {
    throw new OAuthProtocolError("OAuth authorization server metadata must be a JSON object.");
  }

  const issuer = readRequiredString(value, "issuer");
  if (!authorizationServerIssuersMatch(issuer, expectedIssuer)) {
    throw new OAuthProtocolError("OAuth authorization server metadata issuer does not match.");
  }

  return {
    issuer,
    authorizationEndpoint: parseHttpsUrl(
      readRequiredString(value, "authorization_endpoint"),
      "OAuth authorization endpoint",
    ).toString(),
    tokenEndpoint: parseHttpsUrl(
      readRequiredString(value, "token_endpoint"),
      "OAuth token endpoint",
    ).toString(),
    ...readOptionalUrl(value, "registration_endpoint", "registrationEndpoint"),
    ...readOptionalUrl(value, "revocation_endpoint", "revocationEndpoint"),
    ...readOptionalStringArray(value, "scopes_supported", "scopesSupported"),
    ...readOptionalStringArray(value, "grant_types_supported", "grantTypesSupported"),
    ...readOptionalStringArray(value, "response_types_supported", "responseTypesSupported"),
    ...readOptionalStringArray(
      value,
      "code_challenge_methods_supported",
      "codeChallengeMethodsSupported",
    ),
    ...readOptionalStringArray(
      value,
      "token_endpoint_auth_methods_supported",
      "tokenEndpointAuthMethodsSupported",
    ),
    ...readOptionalBoolean(
      value,
      "client_id_metadata_document_supported",
      "clientIdMetadataDocumentSupported",
    ),
  };
}

function authorizationServerIssuersMatch(actual: string, expected: string): boolean {
  if (actual === expected) {
    return true;
  }

  const actualUrl = parseHttpsUrl(actual, "OAuth metadata issuer");
  const expectedUrl = parseHttpsUrl(expected, "OAuth authorization server issuer");
  // Google Workspace MCP advertises its root issuer with a trailing slash,
  // while Google's metadata omits it. Treat only equivalent root URLs as the
  // same issuer; paths and query parameters still require an exact match.
  return (
    actualUrl.origin === expectedUrl.origin &&
    actualUrl.pathname === "/" &&
    expectedUrl.pathname === "/" &&
    actualUrl.search === "" &&
    expectedUrl.search === ""
  );
}

function readOptionalUrl<TKey extends string>(
  value: Record<string, unknown>,
  sourceKey: string,
  targetKey: TKey,
): { [T in TKey]?: string } {
  const candidate = value[sourceKey];
  if (candidate === undefined) {
    return {};
  }
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new OAuthProtocolError(`OAuth metadata ${sourceKey} must be a non-empty string.`);
  }
  return { [targetKey]: parseHttpsUrl(candidate, `OAuth metadata ${sourceKey}`).toString() } as {
    [T in TKey]?: string;
  };
}

function readOptionalStringArray<TKey extends string>(
  value: Record<string, unknown>,
  sourceKey: string,
  targetKey: TKey,
): { [T in TKey]?: string[] } {
  const candidate = value[sourceKey];
  if (candidate === undefined) {
    return {};
  }
  if (
    !Array.isArray(candidate) ||
    candidate.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new OAuthProtocolError(`OAuth metadata ${sourceKey} must be a string array.`);
  }
  return { [targetKey]: candidate.slice() } as { [T in TKey]?: string[] };
}

function readOptionalBoolean<TKey extends string>(
  value: Record<string, unknown>,
  sourceKey: string,
  targetKey: TKey,
): { [T in TKey]?: boolean } {
  const candidate = value[sourceKey];
  if (candidate === undefined) {
    return {};
  }
  if (typeof candidate !== "boolean") {
    throw new OAuthProtocolError(`OAuth metadata ${sourceKey} must be a boolean.`);
  }
  return { [targetKey]: candidate } as { [T in TKey]?: boolean };
}

function readRequiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new OAuthProtocolError(`OAuth metadata ${key} must be a non-empty string.`);
  }
  return candidate;
}

function parseHttpsUrl(value: string, description: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new OAuthProtocolError(`${description} must be an absolute URL.`, { cause: error });
  }
  if (url.protocol !== "https:") {
    throw new OAuthProtocolError(`${description} must use HTTPS.`);
  }
  if (url.username || url.password) {
    throw new OAuthProtocolError(`${description} cannot contain credentials.`);
  }
  if (url.hash) {
    throw new OAuthProtocolError(`${description} cannot contain a fragment.`);
  }
  return url;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emitDiagnostic(
  handler: OAuthDiagnosticHandler | undefined,
  event: Parameters<OAuthDiagnosticHandler>[0],
): void {
  try {
    handler?.(event);
  } catch {
    // Diagnostic consumers cannot alter authorization discovery.
  }
}
