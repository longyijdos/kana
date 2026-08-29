import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadKanaEnvironment } from "@/kana";
import { cleanupConfigTempDirs, createTempDir, createTempEnv } from "./config-fixture";

afterEach(cleanupConfigTempDirs);

describe("Kana config environment", () => {
  test("loads KANA_HOME/.env with priority over the existing environment", () => {
    const kanaHome = createTempDir();
    const env = createTempEnv({
      KANA_HOME: kanaHome,
      DEEPSEEK_API_KEY: "from-shell",
    });
    writeFileSync(
      path.join(kanaHome, ".env"),
      ['DEEPSEEK_API_KEY="from-kana-home"', "KANA_ENV_ONLY=available", ""].join("\n"),
    );

    loadKanaEnvironment(env);

    expect(env.DEEPSEEK_API_KEY).toBe("from-kana-home");
    expect(env.KANA_ENV_ONLY).toBe("available");
  });

  test("leaves the environment unchanged when KANA_HOME/.env is missing", () => {
    const env = createTempEnv({ DEEPSEEK_API_KEY: "from-shell" });

    loadKanaEnvironment(env);

    expect(env.DEEPSEEK_API_KEY).toBe("from-shell");
  });
});
