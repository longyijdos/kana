# OAuth lifecycle

`src/oauth` implements reusable Authorization Code, PKCE, token exchange, refresh, and token-session state without depending on providers, MCP, Kana configuration, persistence paths, or a frontend. Products inject fetch, browser opening, token storage, cancellation, and diagnostic handling.

## Boundary and flow

```text
Product integration
  → discover authorization-server metadata
  → OAuthSession
      ├→ loopback callback server
      ├→ authorization request + PKCE/state
      ├→ authorization-code exchange
      ├→ coalesced refresh
      └→ injected OAuthTokenStore
```

Stateless functions own protocol parsing and request construction. `OAuthSession` owns mutable credentials for one issuer/client/resource binding and serializes interactive authorization, refresh, persistence, invalidation, and shutdown.

OpenAI Codex and MCP add their own product-specific discovery or token-request differences outside this generic boundary; see [OpenAI Codex provider](openai-codex-provider.md) and [MCP](mcp.md).

## Authorization-server discovery

Discovery requires an absolute HTTPS issuer without credentials, query, or fragment. It tries the OAuth authorization-server well-known URL first, then OpenID configuration forms. A non-root issuer also receives the path-suffixed OpenID candidate. Attempts are ordered and independently diagnosed.

Successful metadata must be a bounded JSON object whose `issuer` matches the requested issuer. Only equivalent root URLs may differ by a trailing slash. Authorization, token, optional registration, and revocation endpoints must use HTTPS and contain no credentials or fragment. Optional capability arrays and booleans are validated rather than ignored when malformed.

Fetch redirects are rejected. The default maximum metadata or token response is 256 KiB, decoded as strict UTF-8 and then parsed as JSON. Empty, oversized, invalid UTF-8, and invalid JSON responses fail as protocol errors.

## Authorization request and PKCE

Authorization requests require metadata that declares PKCE `S256`. Kana creates 32 random bytes for the code verifier and another 32 for `state`, encodes them with base64url, and hashes the verifier with SHA-256 for the challenge.

The generated URL fixes `response_type=code`, client ID, redirect URI, state, challenge, and challenge method. Optional scopes, resource, and integration-owned parameters are added afterward. Additional parameters cannot replace reserved OAuth fields and must have non-empty names and values.

Redirect URIs must use HTTPS or HTTP on `localhost`, `127.0.0.1`, or `[::1]`. A resource must be an absolute HTTP(S) URL. The generic client validates these values before opening a browser or sending a token request.

## Loopback callback

The built-in callback server binds one HTTP loopback address. With no explicit redirect URI it asks the OS for a free port and uses `/oauth/callback`; an explicit callback must include a non-zero port and cannot contain credentials, query, or fragment.

Only one callback may be pending. The server accepts `GET` on the configured path, compares `state` before accepting a code or safe OAuth error, bounds the authorization code, and times out after five minutes by default. Other methods, paths, missing pending state, or mismatched state receive an error response without completing the flow.

Callback responses are plain text with `no-store`, a restrictive Content Security Policy, `nosniff`, and connection close. Abort, timeout, server error, or session shutdown rejects the pending callback, removes listeners, and closes the server.

## Token requests

Authorization-code exchange sends `grant_type`, code, redirect URI, and verifier. Refresh sends the refresh token and may repeat resource and scopes. Both use form-encoded POST with redirects disabled unless a provider-specific integration deliberately implements another contract.

Token-endpoint authentication is selected from metadata and configured credentials:

- an explicit `none`, `client_secret_basic`, or `client_secret_post` must be usable and advertised when the server lists methods;
- with a secret and no explicit method, Basic is preferred, then POST;
- without a secret, `none` must be allowed.

Basic authentication form-encodes the client values before constructing the header. POST and public-client modes include `client_id` in the form; POST also includes the secret.

A successful token response requires a non-empty access token and Bearer token type. Provider integrations may explicitly allow an omitted token type, but the generic default rejects it. Optional ID token, refresh token, positive `expires_in`, and scopes are normalized into `OAuthTokenSet`; expiry is stored as an absolute millisecond timestamp. Safe endpoint errors retain only a bounded OAuth error code and HTTP status.

## OAuthSession

An `OAuthSession` is bound to `storageKey`, metadata issuer, client ID, and optional resource. A stored token whose binding differs is deleted before use. Returned token and scope arrays are copied so callers cannot mutate session state.

The first load is coalesced. Concurrent refresh calls share one promise; concurrent authorization with the same scope set also shares one flow, while another scope set is rejected until the current flow ends. By default, a token is considered unusable during its final 60 seconds and refreshes before being returned.

Authorization preserves an existing ID token, refresh token, or scopes when a successful response omits their replacements. Refresh does the same for rotated responses. Store mutations are serialized, and a revision counter prevents a late load, refresh, or authorization from restoring credentials after sign-out or another lifecycle change.

`invalid_grant`, expired/reused/invalidated refresh-token identities delete the stored binding and return to unauthorized state. Other refresh failures remain observable. `signOut()` cancels active authorization and refresh, advances the revision, clears memory, and awaits store deletion. `close()` is idempotent, aborts pending work, and makes later access invalid.

## Persistence and product integration

The generic layer never chooses a file. `OAuthTokenStore` supplies asynchronous load, save, and delete by storage key. Kana's product store writes `<KANA_HOME>/oauth-tokens.json` with owner-only permissions and binds provider or MCP-specific keys; those path and UI decisions remain outside `src/oauth`.

MCP additionally discovers protected-resource metadata and Bearer challenges before creating an `OAuthSession`. OpenAI Codex supplies its fixed client, callback, endpoint behavior, and ChatGPT account binding. Neither integration may expose tokens to Agent messages, sessions, transcript blocks, or diagnostics.

## Diagnostics and failure containment

Generic diagnostics cover metadata attempts, token request success/failure, authorization start/callback/success/failure, and token invalidation. Events contain counts, method, status, safe OAuth identity, expiry/refresh-token presence, or a fixed invalidation reason; they never contain URLs, codes, verifiers, state, client secrets, access/refresh/ID tokens, or response bodies.

Diagnostic handler failures are contained. Cancellation preserves the caller's reason, transport and protocol errors retain typed identities, and cleanup still runs if browser opening, callback handling, token exchange, persistence, or diagnostic delivery fails.
