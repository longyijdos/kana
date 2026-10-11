import { isRetryableProviderHttpStatus, type ProviderHttpError } from "../http";

export function resolveOpenAICodexUrl(baseUrl?: string): string {
  const normalized = (baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
}

export function isOpenAICodexRetryable(error: ProviderHttpError): boolean {
  return (
    error.providerCode !== "subscription_sharing_usage_limit_exceeded" &&
    isRetryableProviderHttpStatus(error.status)
  );
}

export function recoveryHint(code?: string): string {
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return " ChatGPT plan usage limit reached. Manage usage: https://chatgpt.com/settings/usage.";
    case "subscription_sharing_user_not_eligible":
      return " ChatGPT plan usage is unavailable for this account or workspace.";
    case "subscription_sharing_unsupported_capability":
      return " This capability is unsupported for ChatGPT plan usage; check error.param.";
    case "subscription_sharing_route_not_supported":
      return " ChatGPT plan usage requires POST /v1/responses.";
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
      return " Check the saved client registration and granted ChatGPT plan permissions.";
    default:
      return "";
  }
}
