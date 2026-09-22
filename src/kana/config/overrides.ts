import type { KanaConfig } from "./contracts";
import { parseKanaConfig, toRawKanaConfig } from "./parser";

export function applyKanaConfigOverrides(
  config: KanaConfig,
  overrides: readonly string[],
): KanaConfig {
  if (overrides.length === 0) return config;
  const raw = toRawKanaConfig(config);
  for (const override of overrides) {
    const separator = override.indexOf("=");
    const path = override.slice(0, separator).trim();
    if (separator < 0 || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(path)) {
      throw new Error("Config override must use a dotted path=value assignment.");
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = Bun.TOML.parse(`value = ${override.slice(separator + 1)}`) as Record<
        string,
        unknown
      >;
      if (Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, "value")) {
        throw new Error("Expected one value.");
      }
    } catch {
      throw new Error(`Config override ${path} must contain a single valid TOML value.`);
    }
    const keys = path.split(".");
    let table = raw;
    for (const key of keys.slice(0, -1)) {
      if (!Object.hasOwn(table, key)) {
        Object.defineProperty(table, key, {
          value: {},
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      const child = table[key];
      if (
        typeof child !== "object" ||
        child === null ||
        Array.isArray(child) ||
        child instanceof Date
      ) {
        throw new Error(`Config override ${path} traverses a non-table value.`);
      }
      table = child as Record<string, unknown>;
    }
    Object.defineProperty(table, keys.at(-1)!, {
      value: parsed.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return parseKanaConfig(raw);
}
