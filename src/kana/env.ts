import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

import { getKanaConfigPaths } from "./path";

export function loadKanaEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const { home } = getKanaConfigPaths(env);
  const envPath = path.join(home, ".env");

  if (!existsSync(envPath)) {
    return;
  }

  // KANA_HOME/.env is explicit Kana configuration, so it overrides inherited
  // shell values and any workspace .env values Bun loaded during startup.
  // FIXME(Bun 1.3.14): Proxy variables added after startup remain non-enumerable,
  // so Bun.spawn may omit values loaded here. Remove after upgrading to Bun 1.4+.
  Object.assign(env, parseEnv(readFileSync(envPath, "utf8")));
}
