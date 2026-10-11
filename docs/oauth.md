# OAuth lifecycle

`src/oauth` implements reusable Authorization Code, PKCE, token exchange, refresh, and a loopback callback server without depending on providers, MCP, Kana configuration, persistence paths, or a frontend. Products inject fetch, browser opening, token storage, cancellation, and diagnostic handling, and own the lifecycle of the credentials they obtain.

## Boundary and flow

```text
Product integration (OpenAI Codex)
  → supply authorization-server metadata
  → authorization request + PKCE/state
  → loopback callback server
  → authorization-code exchange / refresh
  → product credential store
```

Stateless functions own protocol parsing and request construction. The integration owns mutable credentials: it decides when to authorize, coalesces refresh, persists tokens, and handles invalidation and shutdown.

OpenAI Codex composes these functions with its SIWC registration and identity lifecycle; see [OpenAI Codex provider](openai-codex-provider.md). [MCP](mcp.md) delegates its OAuth protocol to the official SDK and reuses only the loopback callback and the product credential store.

## Authorization-server metadata

Integrations supply authorization-server metadata to the protocol functions. OpenAI Codex uses fixed SIWC authorization, token, and JWKS endpoints; logout discovers the revocation endpoint. The generic OAuth layer performs no metadata discovery. MCP discovery belongs to the official SDK.

Token requests reject fetch redirects. The default maximum token response is 256 KiB, decoded as strict UTF-8 and then parsed as JSON. Empty, oversized, invalid UTF-8, and invalid JSON responses fail as protocol errors.

## Authorization request and PKCE

Authorization requests require metadata that declares PKCE `S256`. Kana creates 32 random bytes for the code verifier and another 32 for `state`, encodes them with base64url, and hashes the verifier with SHA-256 for the challenge.

The generated URL fixes `response_type=code`, client ID, redirect URI, state, challenge, and challenge method. Optional scopes, resource, and integration-owned parameters are added afterward. Additional parameters cannot replace reserved OAuth fields and must have non-empty names and values.

Redirect URIs must use HTTPS or HTTP on `localhost`, `127.0.0.1`, or `[::1]`. A resource must be an absolute HTTP(S) URL. The generic client validates these values before opening a browser or sending a token request.

## Loopback callback

The built-in callback server binds one HTTP loopback address. With no explicit redirect URI it asks the OS for a free port and uses `/oauth/callback`; an explicit callback must include a non-zero port and cannot contain credentials, query, or fragment.

Only one callback may be pending. The server accepts `GET` on the configured path, compares `state` before accepting a code or safe OAuth error, bounds the authorization code, and times out after five minutes by default. Other methods, paths, missing pending state, or mismatched state receive an error response without completing the flow.

Callback responses are plain text with `no-store`, a restrictive Content Security Policy, `nosniff`, and connection close. Abort, timeout, server error, or shutdown rejects the pending callback, removes listeners, and closes the server.

## Token requests

Authorization-code exchange sends `grant_type`, code, redirect URI, and verifier. Refresh sends the refresh token and may repeat resource and scopes. Both use form-encoded POST with redirects disabled unless a provider-specific integration deliberately implements another contract.

Token-endpoint authentication is selected from metadata and configured credentials:

- an explicit `none`, `client_secret_basic`, or `client_secret_post` must be usable and advertised when the server lists methods;
- with a secret and no explicit method, Basic is preferred, then POST;
- without a secret, `none` must be allowed.

Basic authentication form-encodes the client values before constructing the header. POST and public-client modes include `client_id` in the form; POST also includes the secret.

A successful token response requires a non-empty access token and Bearer token type. Provider integrations may explicitly allow an omitted token type, but the generic default rejects it. Optional ID token, refresh token, positive `expires_in`, and scopes are normalized into `OAuthTokenSet`; expiry is stored as an absolute millisecond timestamp. Safe endpoint errors retain only a bounded OAuth error code and HTTP status.

## Persistence and product integration

The generic layer never chooses a file. `OAuthTokenStore` supplies asynchronous load, save, and delete by storage key. Kana's product store writes `<KANA_HOME>/oauth-tokens.json` with owner-only permissions and binds provider or MCP-specific keys; those path and UI decisions remain outside `src/oauth`.

Every product-store mutation takes a shared file lock, rereads the latest file, applies its update, and atomically replaces the file. This serializes provider tokens, Codex registration state, and MCP tokens and clients across store instances and processes. A separate Codex lifecycle lock covers refresh and revocation, including their network requests. File mutations can run inside that lifecycle lock, but the file lock never spans network I/O or acquires the lifecycle lock.

MCP uses the SDK's `OAuthClientProvider` and `auth` flow with Kana's shared loopback callback and credential store. The shared callback also returns an optional issued `client_id` for SIWC dynamic registration. MCP passes the optional authorization-response `iss` to the SDK for issuer validation after checking `state`. OpenAI Codex composes the stateless OAuth requests and callback listener with its SIWC dynamic registration, OIDC identity verification, protected registration store, and host-locked token rotation. Neither integration may expose tokens to Agent messages, sessions, transcript blocks, or diagnostics.

## Diagnostics and failure containment

Generic diagnostics cover token request success/failure, authorization start/callback/success/failure, and token invalidation. Events contain counts, method, status, safe OAuth identity, expiry/refresh-token presence, or a fixed invalidation reason; they never contain URLs, codes, verifiers, state, client secrets, access/refresh/ID tokens, or response bodies.

Diagnostic handler failures are contained. Cancellation preserves the caller's reason, transport and protocol errors retain typed identities, and cleanup still runs if browser opening, callback handling, token exchange, persistence, or diagnostic delivery fails.
