import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type CreateKanaUpdaterOptions,
  createKanaUpdater,
  type KanaUpdateProgressEvent,
} from "@/kana";

const CURRENT_VERSION = "1.0.0";
const LATEST_VERSION = "1.1.0";
const PLATFORM = "darwin";
const ARCHITECTURE = "arm64";
const ASSET_NAME = "kana-darwin-arm64";
const RELEASE_API_URL = "https://updates.test/releases/latest";
const ASSET_URL = "https://updates.test/assets/kana";
const OLD_BINARY = "old-kana-binary";
const NEW_BINARY = Buffer.from("new-kana-binary");
const NEW_BINARY_SHA256 = createHash("sha256").update(NEW_BINARY).digest("hex");
const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Kana self-update", () => {
  test("refuses to update a source distribution before network access", async () => {
    let fetchCalls = 0;
    const updater = createKanaUpdater({
      currentVersion: CURRENT_VERSION,
      distribution: "source",
      fetch: async () => {
        fetchCalls += 1;
        return new Response();
      },
    });

    await expect(updater()).rejects.toThrow(
      "Kana update failed [distribution]: Self-update is only available",
    );
    expect(fetchCalls).toBe(0);
  });

  test.each([
    ["1.0.0", "up-to-date"],
    ["0.9.0", "ahead"],
    ["1.1.0", "update-available"],
  ] as const)(
    "reports release %s as %s without downloading an asset",
    async (releaseVersion, expectedStatus) => {
      const fixture = createFixture({ releaseVersion });

      const result = await fixture.updater({ checkOnly: true });

      expect(result).toEqual({
        status: expectedStatus,
        currentVersion: CURRENT_VERSION,
        latestVersion: releaseVersion,
      });
      expect(fixture.fetchCalls.map((call) => call.url)).toEqual([RELEASE_API_URL]);
      expect(fixture.runCalls).toEqual([]);
      expect(readFileSync(fixture.executablePath, "utf8")).toBe(OLD_BINARY);
    },
  );

  test("downloads, verifies, initializes, and atomically replaces Kana", async () => {
    const fixture = createFixture();
    const progress: KanaUpdateProgressEvent[] = [];

    const result = await fixture.updater({
      onProgress: (event) => {
        progress.push(event);
      },
    });

    expect(result).toEqual({
      status: "updated",
      executablePath: fixture.executablePath,
      previousVersion: CURRENT_VERSION,
      currentVersion: LATEST_VERSION,
    });
    expect(readFileSync(fixture.executablePath)).toEqual(NEW_BINARY);
    expect(statSync(fixture.executablePath).mode & 0o777).toBe(0o755);
    expect(readdirSync(path.dirname(fixture.executablePath))).toEqual(["kana"]);
    expect(fixture.runCalls.map((call) => call.args)).toEqual([["--version"], ["install"]]);
    expect(fixture.runCalls.every((call) => call.executablePath !== fixture.executablePath)).toBe(
      true,
    );
    expect(fixture.runCalls.every((call) => call.env === fixture.env)).toBe(true);
    expect(fixture.fetchCalls.map((call) => call.url)).toEqual([RELEASE_API_URL, ASSET_URL]);
    expect(new Headers(fixture.fetchCalls[0]?.init.headers).get("user-agent")).toBe(
      `kana/${CURRENT_VERSION}`,
    );
    expect(progress.map((event) => event.phase)).toEqual([
      "checking",
      "downloading",
      "verifying",
      "initializing",
      "replacing",
    ]);
  });

  test("keeps the old binary when checksum verification fails", async () => {
    const fixture = createFixture({ sha256: "0".repeat(64) });

    await expect(fixture.updater()).rejects.toThrow(
      "Kana update failed [asset_verification]: Checksum verification failed",
    );

    expect(readFileSync(fixture.executablePath, "utf8")).toBe(OLD_BINARY);
    expect(readdirSync(path.dirname(fixture.executablePath))).toEqual(["kana"]);
    expect(fixture.runCalls).toEqual([]);
  });

  test("keeps the old binary when the candidate reports another version", async () => {
    const fixture = createFixture({
      runExecutable: async (_executablePath, args) => (args[0] === "--version" ? "9.9.9\n" : ""),
    });

    await expect(fixture.updater()).rejects.toThrow(
      'Kana update failed [candidate_validation]: Downloaded Kana reported "9.9.9"',
    );

    expect(readFileSync(fixture.executablePath, "utf8")).toBe(OLD_BINARY);
    expect(readdirSync(path.dirname(fixture.executablePath))).toEqual(["kana"]);
    expect(fixture.runCalls.map((call) => call.args)).toEqual([["--version"]]);
  });

  test("keeps the old binary when support-file initialization fails", async () => {
    const fixture = createFixture({
      runExecutable: async (_executablePath, args) => {
        if (args[0] === "install") {
          throw new Error("install failed");
        }
        return `${LATEST_VERSION}\n`;
      },
    });

    await expect(fixture.updater()).rejects.toThrow(
      "Kana update failed [candidate_initialization]",
    );

    expect(readFileSync(fixture.executablePath, "utf8")).toBe(OLD_BINARY);
    expect(readdirSync(path.dirname(fixture.executablePath))).toEqual(["kana"]);
    expect(fixture.runCalls.map((call) => call.args)).toEqual([["--version"], ["install"]]);
  });

  test("does not overwrite an executable changed by another installer", async () => {
    let targetPath = "";
    const fixture = createFixture({
      runExecutable: async (_executablePath, args) => {
        if (args[0] === "install") {
          writeFileSync(targetPath, "newer-external-install");
        }
        return args[0] === "--version" ? `${LATEST_VERSION}\n` : "";
      },
    });
    targetPath = fixture.executablePath;

    await expect(fixture.updater()).rejects.toThrow("Kana update failed [target_changed]");

    expect(readFileSync(fixture.executablePath, "utf8")).toBe("newer-external-install");
    expect(readdirSync(path.dirname(fixture.executablePath))).toEqual(["kana"]);
  });

  test("rejects unsupported release platforms without touching the executable", async () => {
    const fixture = createFixture({ platform: "win32" });

    await expect(fixture.updater()).rejects.toThrow("Kana update failed [unsupported_platform]");

    expect(fixture.fetchCalls.map((call) => call.url)).toEqual([RELEASE_API_URL]);
    expect(readFileSync(fixture.executablePath, "utf8")).toBe(OLD_BINARY);
  });

  test("does not let progress reporting failures interrupt an update", async () => {
    const fixture = createFixture();

    await expect(
      fixture.updater({
        onProgress: () => {
          throw new Error("diagnostic sink failed");
        },
      }),
    ).resolves.toMatchObject({
      status: "updated",
      currentVersion: LATEST_VERSION,
    });
    expect(readFileSync(fixture.executablePath)).toEqual(NEW_BINARY);
  });
});

type FixtureOptions = {
  platform?: NodeJS.Platform;
  releaseVersion?: string;
  runExecutable?: NonNullable<CreateKanaUpdaterOptions["runExecutable"]>;
  sha256?: string;
};

type FetchCall = {
  init: RequestInit;
  url: string;
};

type RunCall = {
  args: string[];
  env: NodeJS.ProcessEnv;
  executablePath: string;
};

function createFixture(options: FixtureOptions = {}) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "kana-self-update-"));
  tempDirs.push(tempDir);
  const executablePath = path.join(tempDir, "kana");
  writeFileSync(executablePath, OLD_BINARY);
  chmodSync(executablePath, 0o755);

  const env: NodeJS.ProcessEnv = {
    KANA_HOME: path.join(tempDir, ".kana"),
  };
  const fetchCalls: FetchCall[] = [];
  const runCalls: RunCall[] = [];
  const releaseVersion = options.releaseVersion ?? LATEST_VERSION;
  const asset = {
    browser_download_url: ASSET_URL,
    digest: `sha256:${options.sha256 ?? NEW_BINARY_SHA256}`,
    name: ASSET_NAME,
    size: NEW_BINARY.byteLength,
  };
  const fakeFetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    fetchCalls.push({ init, url });

    if (url === RELEASE_API_URL) {
      return Response.json({
        assets: [asset],
        tag_name: `v${releaseVersion}`,
      });
    }
    if (url === ASSET_URL) {
      return new Response(NEW_BINARY);
    }
    return new Response("not found", { status: 404, statusText: "Not Found" });
  };

  const updater = createKanaUpdater({
    architecture: ARCHITECTURE,
    currentVersion: CURRENT_VERSION,
    distribution: "direct",
    env,
    executablePath,
    fetch: fakeFetch,
    platform: options.platform ?? PLATFORM,
    releaseApiUrl: RELEASE_API_URL,
    runExecutable: async (candidatePath, args, candidateEnv) => {
      runCalls.push({
        args,
        env: candidateEnv,
        executablePath: candidatePath,
      });
      if (options.runExecutable) {
        return options.runExecutable(candidatePath, args, candidateEnv);
      }
      return args[0] === "--version" ? `${LATEST_VERSION}\n` : "";
    },
  });

  return {
    env,
    executablePath,
    fetchCalls,
    runCalls,
    updater,
  };
}
