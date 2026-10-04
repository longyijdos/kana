import { getBooleanProperty, getNumberProperty } from "../properties";

export function formatGlobOutput(result: object): string {
  const totalMatches = getNumberProperty(result, "totalMatches");
  const matches = readObjectArrayLength(result, "matches");
  const truncated = getBooleanProperty(result, "truncated");

  if (totalMatches === undefined || matches === undefined) {
    return "";
  }
  return `${matches} of ${totalMatches} matches${truncated ? " (truncated)" : ""}`;
}
function readObjectArrayLength(value: object, key: string): number | undefined {
  const property = (value as Record<string, unknown>)[key];

  return Array.isArray(property) ? property.length : undefined;
}
