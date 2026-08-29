# OAuth 生命周期

`src/oauth` 实现可复用的 Authorization Code、PKCE、token exchange、refresh 和 token-session 状态，不依赖 provider、MCP、Kana 配置、持久路径或前端。产品层注入 fetch、浏览器打开、token storage、取消与诊断处理。

## 边界与流程

```text
产品集成
  → 发现 authorization-server metadata
  → OAuthSession
      ├→ loopback callback server
      ├→ authorization request + PKCE/state
      ├→ authorization-code exchange
      ├→ 合并 refresh
      └→ 注入的 OAuthTokenStore
```

无状态函数负责协议解析与 request 构造；`OAuthSession` 持有一个 issuer/client/resource 绑定的可变凭据，并串行处理交互授权、refresh、持久化、失效和 shutdown。

OpenAI Codex 与 MCP 在此通用边界之外增加各自的 discovery 或 token-request 差异；见 [OpenAI Codex provider](openai-codex-provider.zh-CN.md)和 [MCP](mcp.zh-CN.md)。

## Authorization-server discovery

Discovery 要求 issuer 是不含凭据、query 或 fragment 的绝对 HTTPS URL。它先尝试 OAuth authorization-server well-known URL，再尝试 OpenID configuration 形式；非根 issuer 还会增加 path-suffixed OpenID candidate。尝试顺序固定，并各自发送诊断。

成功 metadata 必须是有界 JSON object，且 `issuer` 与请求值匹配；只有等价根 URL 可以只在尾部斜杠上不同。Authorization、token 以及可选 registration、revocation endpoint 必须使用 HTTPS，且不含凭据或 fragment。可选 capability array 和 boolean 格式错误时会失败，不会静默忽略。

Fetch 拒绝 redirect。Metadata 与 token response 默认最大 256 KiB，先以严格 UTF-8 解码，再解析 JSON；空 body、超限、非法 UTF-8 和非法 JSON 都按协议错误处理。

## Authorization request 与 PKCE

Authorization request 要求 metadata 声明支持 PKCE `S256`。Kana 为 code verifier 生成 32 个随机字节，为 `state` 另生成 32 个随机字节，以 base64url 编码，并用 SHA-256 哈希 verifier 得到 challenge。

生成 URL 固定设置 `response_type=code`、client ID、redirect URI、state、challenge 与 challenge method，再增加可选 scope、resource 和集成层参数。附加参数不能覆盖保留 OAuth 字段，名称和值都不能为空。

Redirect URI 必须使用 HTTPS，或使用 `localhost`、`127.0.0.1`、`[::1]` 上的 HTTP。Resource 必须是绝对 HTTP(S) URL。通用 client 会在打开浏览器或发送 token request 前校验这些值。

## Loopback callback

内置 callback server 只绑定一个 HTTP loopback 地址。未显式配置 redirect URI 时由操作系统分配空闲端口，并使用 `/oauth/callback`；显式 callback 必须包含非零端口，且不含凭据、query 或 fragment。

同一时间只能等待一个 callback。Server 只接受配置 path 上的 `GET`，先比较 `state`，再接受 code 或安全 OAuth error；authorization code 有长度上限，默认五分钟超时。其它 method、path、没有 pending state 或 state 不匹配都会返回错误，但不会完成该流程。

Callback response 是 plain text，并带有 `no-store`、严格 Content Security Policy、`nosniff` 与 connection close。Abort、timeout、server error 或 session shutdown 会拒绝 pending callback、移除 listener 并关闭 server。

## Token request

Authorization-code exchange 发送 `grant_type`、code、redirect URI 和 verifier。Refresh 发送 refresh token，并可重复 resource 与 scopes。除非 provider 集成刻意实现另一合同，二者都使用 form-encoded POST 且拒绝 redirect。

Token endpoint 认证从 metadata 与配置凭据选择：

- 显式 `none`、`client_secret_basic` 或 `client_secret_post` 必须可用，并在 server 声明 methods 时位于其列表中；
- 配有 secret 但未指定 method 时，先选 Basic，再选 POST；
- 没有 secret 时必须允许 `none`。

Basic authentication 会先对 client 值做 form encoding，再构造 header。POST 与 public-client 模式把 `client_id` 放入 form；POST 还加入 secret。

成功 token response 必须有非空 access token 和 Bearer token type。Provider 集成可以显式允许缺失 token type，但通用默认会拒绝。可选 ID token、refresh token、正数 `expires_in` 和 scopes 会规范化成 `OAuthTokenSet`，过期时间保存为绝对毫秒时间戳。安全 endpoint error 只保留有界 OAuth error code 与 HTTP status。

## OAuthSession

`OAuthSession` 绑定 `storageKey`、metadata issuer、client ID 和可选 resource。持久 token 的绑定不同时会在使用前删除。返回 token 与 scope array 都会复制，调用方不能修改 session 内部状态。

首次 load 会合并。并发 refresh 共用一个 promise；相同 scope set 的并发 authorization 也共用同一流程，不同 scope set 则在当前流程结束前被拒绝。默认情况下，token 在最后 60 秒内视为不可用，会先 refresh 再返回。

Authorization 成功但 response 未替换 ID token、refresh token 或 scopes 时会保留旧值；refresh 对轮换 response 使用相同规则。Store mutation 串行执行，revision counter 防止迟到 load、refresh 或 authorization 在 sign-out 或其它生命周期变化后恢复旧凭据。

`invalid_grant` 以及 expired/reused/invalidated refresh-token identity 会删除持久绑定并回到 unauthorized；其它 refresh failure 仍向调用方报告。`signOut()` 会取消活动 authorization 与 refresh、推进 revision、清空内存并等待 store 删除。`close()` 幂等地中止 pending work，并使后续访问失效。

## 持久化与产品集成

通用层不选择任何文件。`OAuthTokenStore` 按 storage key 提供异步 load、save 与 delete。Kana 产品 store 以 owner-only 权限写入 `<KANA_HOME>/oauth-tokens.json`，并绑定 provider 或 MCP 专属 key；路径与 UI 决策不属于 `src/oauth`。

MCP 会先发现 protected-resource metadata 与 Bearer challenge，再创建 `OAuthSession`。OpenAI Codex 提供固定 client、callback、endpoint 行为与 ChatGPT account 绑定。两种集成都不能把 token 暴露给 Agent message、session、transcript block 或诊断。

## 诊断与失败隔离

通用诊断覆盖 metadata 尝试、token request 成功/失败、authorization start/callback/success/failure 和 token invalidation。Event 只包含计数、method、status、安全 OAuth identity、expiry/refresh-token 是否存在或固定失效原因；绝不包含 URL、code、verifier、state、client secret、access/refresh/ID token 或 response body。

Diagnostic handler failure 会被隔离。取消保留调用方 reason，transport 与 protocol error 保留 typed identity；即使浏览器打开、callback、token exchange、持久化或诊断投递失败，cleanup 仍会执行。
