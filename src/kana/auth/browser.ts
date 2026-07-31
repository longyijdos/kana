import type { Logger } from "@/logging";

export type OpenKanaOAuthAuthorizationUrlOptions = {
  platform?: NodeJS.Platform;
  getLogger?: () => Logger;
};

export async function openKanaOAuthAuthorizationUrl(
  authorizationUrl: string,
  options: OpenKanaOAuthAuthorizationUrlOptions = {},
): Promise<void> {
  const url = parseAuthorizationUrl(authorizationUrl);
  const platform = options.platform ?? process.platform;
  const command = selectBrowserCommand(platform, url.toString());

  let processHandle: ReturnType<typeof Bun.spawn>;
  try {
    processHandle = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch (error) {
    logBrowserFailure(options.getLogger, platform, "spawn", error);
    throw new Error("Failed to launch the OAuth authorization browser.", { cause: error });
  }

  const exitCode = await processHandle.exited;
  if (exitCode !== 0) {
    logBrowserFailure(options.getLogger, platform, "exit", undefined, exitCode);
    throw new Error(`OAuth authorization browser command exited with code ${exitCode}.`);
  }

  try {
    options.getLogger?.().info("oauth.browser_opened", {
      component: "oauth_browser",
      platform,
    });
  } catch {
    // Browser launch succeeds independently of diagnostic logging.
  }
}

function parseAuthorizationUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("OAuth authorization URL must be absolute.", { cause: error });
  }
  if (url.protocol !== "https:") {
    throw new Error("OAuth authorization URL must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("OAuth authorization URL cannot contain credentials.");
  }
  return url;
}

function selectBrowserCommand(platform: NodeJS.Platform, url: string): string[] {
  if (platform === "darwin") {
    return ["open", url];
  }
  if (platform === "linux") {
    return ["xdg-open", url];
  }
  throw new Error(`Opening an OAuth browser is not supported on ${platform}.`);
}

function logBrowserFailure(
  getLogger: (() => Logger) | undefined,
  platform: NodeJS.Platform,
  phase: "spawn" | "exit",
  error?: unknown,
  exitCode?: number,
): void {
  try {
    getLogger?.().warn("oauth.browser_open_failed", {
      component: "oauth_browser",
      platform,
      phase,
      ...(error === undefined ? {} : { error }),
      ...(exitCode === undefined ? {} : { exitCode }),
    });
  } catch {
    // Browser launch failures are reported even if diagnostic logging is unavailable.
  }
}
