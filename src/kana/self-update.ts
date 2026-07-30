import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, createReadStream, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { KANA_DISTRIBUTION, KANA_VERSION, type KanaDistribution } from "../version";
import { formatError } from "./format";

const execFileAsync = promisify(execFile);

const RELEASE_API_URL = "https://api.github.com/repos/longyijdos/kana/releases/latest";
const METADATA_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const CANDIDATE_TIMEOUT_MS = 60_000;
const MAX_BINARY_BYTES = 512 * 1024 * 1024;

export type KanaUpdateProgressEvent =
  | { phase: "checking"; currentVersion: string }
  | { phase: "downloading"; platform: string; version: string }
  | { phase: "verifying"; version: string }
  | { phase: "initializing"; version: string }
  | { phase: "replacing"; executablePath: string; version: string };

export type UpdateKanaOptions = {
  checkOnly?: boolean;
  onProgress?: (event: KanaUpdateProgressEvent) => void;
};

export type KanaUpdateResult =
  | {
      status: "up-to-date" | "ahead" | "update-available";
      currentVersion: string;
      latestVersion: string;
    }
  | {
      status: "updated";
      executablePath: string;
      previousVersion: string;
      currentVersion: string;
    };

type ExecutableRunner = (
  executablePath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<string>;

type UpdateFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type CreateKanaUpdaterOptions = {
  architecture?: string;
  currentVersion?: string;
  distribution?: KanaDistribution;
  env?: NodeJS.ProcessEnv;
  executablePath?: string;
  fetch?: UpdateFetch;
  platform?: NodeJS.Platform;
  releaseApiUrl?: string;
  runExecutable?: ExecutableRunner;
};

export function createKanaUpdater(
  dependencies: CreateKanaUpdaterOptions = {},
): (options?: UpdateKanaOptions) => Promise<KanaUpdateResult> {
  const architecture = dependencies.architecture ?? process.arch;
  const currentVersion = dependencies.currentVersion ?? KANA_VERSION;
  const distribution = dependencies.distribution ?? KANA_DISTRIBUTION;
  const env = dependencies.env ?? process.env;
  const executablePath = dependencies.executablePath ?? process.execPath;
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const platform = dependencies.platform ?? process.platform;
  const releaseApiUrl = dependencies.releaseApiUrl ?? RELEASE_API_URL;
  const runExecutable = dependencies.runExecutable ?? runKanaExecutable;

  return async (options: UpdateKanaOptions = {}): Promise<KanaUpdateResult> => {
    if (distribution !== "direct") {
      throw failure(
        "distribution",
        "Self-update is only available in Kana binaries built by the direct installer.",
      );
    }

    report(options.onProgress, { phase: "checking", currentVersion });
    const release = await loadLatestRelease(fetch, releaseApiUrl, currentVersion);
    const comparison = compareVersions(currentVersion, release.version);

    if (comparison === 0) {
      return {
        status: "up-to-date",
        currentVersion,
        latestVersion: release.version,
      };
    }
    if (comparison > 0) {
      return {
        status: "ahead",
        currentVersion,
        latestVersion: release.version,
      };
    }
    if (options.checkOnly) {
      return {
        status: "update-available",
        currentVersion,
        latestVersion: release.version,
      };
    }

    const platformName = resolvePlatform(platform, architecture);
    const assetName = `kana-${platformName}`;
    const binaryAsset = findAsset(release.assets, assetName);
    if (binaryAsset.size > MAX_BINARY_BYTES) {
      throw failure(
        "asset_metadata",
        `${binaryAsset.name} exceeds the ${MAX_BINARY_BYTES}-byte safety limit.`,
      );
    }

    const originalIdentity = readIdentity(executablePath);
    const temporaryPath = path.join(
      path.dirname(executablePath),
      `.${path.basename(executablePath)}.${process.pid}.${randomUUID()}.update`,
    );

    try {
      report(options.onProgress, {
        phase: "downloading",
        platform: platformName,
        version: release.version,
      });
      const downloadedBytes = await downloadBinary(fetch, binaryAsset, temporaryPath);
      if (downloadedBytes !== binaryAsset.size) {
        throw failure(
          "asset_verification",
          `Downloaded ${downloadedBytes} bytes for ${assetName}, expected ${binaryAsset.size}.`,
        );
      }
      report(options.onProgress, { phase: "verifying", version: release.version });
      const actualChecksum = await hashFile(temporaryPath);
      if (actualChecksum !== binaryAsset.sha256) {
        throw failure("asset_verification", `Checksum verification failed for ${assetName}.`);
      }
      try {
        chmodSync(temporaryPath, 0o755);
      } catch (error) {
        throw failure(
          "asset_verification",
          `Could not make the downloaded binary executable: ${formatError(error)}`,
          error,
        );
      }

      const reportedVersion = (
        await runCandidate(runExecutable, temporaryPath, ["--version"], env, "candidate_validation")
      ).trim();
      if (reportedVersion !== release.version) {
        throw failure(
          "candidate_validation",
          `Downloaded Kana reported ${JSON.stringify(reportedVersion)}, expected ${release.version}.`,
        );
      }

      report(options.onProgress, { phase: "initializing", version: release.version });
      await runCandidate(
        runExecutable,
        temporaryPath,
        ["install"],
        env,
        "candidate_initialization",
      );

      // Another installer may have replaced Kana while the download was in
      // flight. Do not overwrite a directory entry this process did not inspect.
      assertIdentityUnchanged(executablePath, originalIdentity);
      report(options.onProgress, {
        phase: "replacing",
        executablePath,
        version: release.version,
      });
      try {
        renameSync(temporaryPath, executablePath);
      } catch (error) {
        throw failure(
          "replacement",
          `Could not replace ${executablePath}: ${formatError(error)}`,
          error,
        );
      }

      return {
        status: "updated",
        executablePath,
        previousVersion: currentVersion,
        currentVersion: release.version,
      };
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  };
}

export const updateKana = createKanaUpdater();

type FailureCode =
  | "asset_download"
  | "asset_metadata"
  | "asset_verification"
  | "candidate_initialization"
  | "candidate_validation"
  | "distribution"
  | "release_check"
  | "release_metadata"
  | "replacement"
  | "target_changed"
  | "target_validation"
  | "unsupported_platform";

type ReleaseAsset = {
  downloadUrl: string;
  name: string;
  sha256: string;
  size: number;
};

type LatestRelease = {
  assets: ReleaseAsset[];
  version: string;
};

type ExecutableIdentity = {
  device: number;
  inode: number;
  modifiedAtMs: number;
  size: number;
};

async function loadLatestRelease(
  fetch: UpdateFetch,
  url: string,
  currentVersion: string,
): Promise<LatestRelease> {
  const response = await request(
    fetch,
    url,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": `kana/${currentVersion}`,
      },
    },
    METADATA_TIMEOUT_MS,
    "release_check",
    "latest Kana release",
  );

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw failure(
      "release_metadata",
      `Could not parse the latest release response: ${formatError(error)}`,
      error,
    );
  }
  if (
    !isRecord(payload) ||
    typeof payload.tag_name !== "string" ||
    !Array.isArray(payload.assets)
  ) {
    throw failure("release_metadata", "Latest release response is missing tag_name or assets.");
  }

  return {
    version: normalizeReleaseVersion(payload.tag_name),
    assets: payload.assets.map(parseAsset),
  };
}

function parseAsset(value: unknown): ReleaseAsset {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.browser_download_url !== "string" ||
    typeof value.digest !== "string" ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0
  ) {
    throw failure("asset_metadata", "Release asset has an invalid name, URL, or size.");
  }
  const digest = /^sha256:([a-fA-F0-9]{64})$/.exec(value.digest);
  if (!digest) {
    throw failure("asset_metadata", `Release asset ${value.name} has an invalid SHA-256 digest.`);
  }

  let url: URL;
  try {
    url = new URL(value.browser_download_url);
  } catch (error) {
    throw failure("asset_metadata", `Release asset ${value.name} has an invalid URL.`, error);
  }
  if (url.protocol !== "https:") {
    throw failure("asset_metadata", `Release asset ${value.name} URL must use HTTPS.`);
  }

  return {
    downloadUrl: url.toString(),
    name: value.name,
    sha256: (digest[1] as string).toLowerCase(),
    size: value.size,
  };
}

function findAsset(assets: ReleaseAsset[], name: string): ReleaseAsset {
  const matches = assets.filter((asset) => asset.name === name);
  if (matches.length !== 1) {
    throw failure(
      "asset_metadata",
      `Expected one release asset named ${name}, found ${matches.length}.`,
    );
  }
  return matches[0] as ReleaseAsset;
}

async function downloadBinary(
  fetch: UpdateFetch,
  asset: ReleaseAsset,
  destination: string,
): Promise<number> {
  const response = await request(
    fetch,
    asset.downloadUrl,
    {},
    DOWNLOAD_TIMEOUT_MS,
    "asset_download",
    asset.name,
  );
  try {
    return await Bun.write(destination, response);
  } catch (error) {
    throw failure("asset_download", `Could not write ${asset.name}: ${formatError(error)}`, error);
  }
}

async function request(
  fetch: UpdateFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  code: FailureCode,
  resource: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw failure(code, `Could not fetch ${resource}: ${formatError(error)}`, error);
  }
  if (!response.ok) {
    throw failure(code, `Fetching ${resource} returned ${response.status} ${response.statusText}.`);
  }
  return response;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(filePath)) {
      hash.update(chunk);
    }
  } catch (error) {
    throw failure(
      "asset_verification",
      `Could not hash the downloaded binary: ${formatError(error)}`,
      error,
    );
  }
  return hash.digest("hex");
}

async function runCandidate(
  runExecutable: ExecutableRunner,
  executablePath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  code: "candidate_initialization" | "candidate_validation",
): Promise<string> {
  try {
    return await runExecutable(executablePath, args, env);
  } catch (error) {
    throw failure(
      code,
      `Downloaded Kana could not run ${args.join(" ")}: ${formatError(error)}`,
      error,
    );
  }
}

async function runKanaExecutable(
  executablePath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await execFileAsync(executablePath, args, {
    encoding: "utf8",
    env,
    maxBuffer: 1024 * 1024,
    timeout: CANDIDATE_TIMEOUT_MS,
    windowsHide: true,
  });
  return String(result.stdout);
}

function resolvePlatform(platform: NodeJS.Platform, architecture: string): string {
  const os = platform === "darwin" || platform === "linux" ? platform : undefined;
  const arch = architecture === "arm64" ? "arm64" : architecture === "x64" ? "x64" : undefined;
  if (!os || !arch) {
    throw failure(
      "unsupported_platform",
      `Kana self-update does not support ${platform}-${architecture}.`,
    );
  }
  return `${os}-${arch}`;
}

function readIdentity(executablePath: string): ExecutableIdentity {
  try {
    const stat = statSync(executablePath);
    if (!stat.isFile()) {
      throw new Error("path is not a regular file");
    }
    return {
      device: stat.dev,
      inode: stat.ino,
      modifiedAtMs: stat.mtimeMs,
      size: stat.size,
    };
  } catch (error) {
    throw failure(
      "target_validation",
      `Cannot update ${executablePath}: ${formatError(error)}`,
      error,
    );
  }
}

function assertIdentityUnchanged(executablePath: string, expected: ExecutableIdentity): void {
  const current = readIdentity(executablePath);
  if (
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    current.modifiedAtMs !== expected.modifiedAtMs ||
    current.size !== expected.size
  ) {
    throw failure(
      "target_changed",
      `The Kana executable changed while the update was downloading: ${executablePath}.`,
    );
  }
}

function normalizeReleaseVersion(tag: string): string {
  return tag.trim().replace(/^v/, "");
}

function compareVersions(left: string, right: string): number {
  try {
    return Bun.semver.order(left, right);
  } catch (error) {
    throw failure(
      "release_metadata",
      `Could not compare Kana versions ${JSON.stringify(left)} and ${JSON.stringify(right)}.`,
      error,
    );
  }
}

function failure(code: FailureCode, message: string, cause?: unknown): Error {
  return new Error(
    `Kana update failed [${code}]: ${message}`,
    cause === undefined ? undefined : { cause },
  );
}

function report(onProgress: UpdateKanaOptions["onProgress"], event: KanaUpdateProgressEvent): void {
  try {
    onProgress?.(event);
  } catch {
    // Update correctness does not depend on diagnostic progress reporting.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
