import packageJson from "../package.json" with { type: "json" };

declare const __KANA_DISTRIBUTION__: unknown;

export type KanaDistribution = "direct" | "source";

export const KANA_VERSION = packageJson.version;
export const KANA_DISTRIBUTION: KanaDistribution =
  typeof __KANA_DISTRIBUTION__ === "undefined"
    ? "source"
    : readKanaDistribution(__KANA_DISTRIBUTION__);

function readKanaDistribution(value: unknown): KanaDistribution {
  if (value === "direct" || value === "source") {
    return value;
  }
  throw new Error(`Invalid Kana build distribution: ${String(value)}.`);
}
