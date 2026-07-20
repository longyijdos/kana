import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

import { getKanaConfigPaths } from "./config";

export function loadKanaEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const { home } = getKanaConfigPaths(env);
  const envPath = path.join(home, ".env");

  if (!existsSync(envPath)) {
    return;
  }

  // KANA_HOME/.env is explicit Kana configuration, so it overrides inherited
  // shell values and any workspace .env values Bun loaded during startup.
  Object.assign(env, parseEnv(readFileSync(envPath, "utf8")));
}
