import { getBooleanProperty, getNumberProperty, getStringProperty } from "../properties";

export function formatListOutput(result: object): string {
  const path = getStringProperty(result, "path");
  const totalEntries = getNumberProperty(result, "totalEntries");
  const entries = readObjectArrayLength(result, "entries");
  const truncated = getBooleanProperty(result, "truncated");

  if (!path || totalEntries === undefined || entries === undefined) {
    return path ?? "";
  }

  return `${path}: ${entries} of ${totalEntries} entries${truncated ? " (truncated)" : ""}`;
}
function readObjectArrayLength(value: object, key: string): number | undefined {
  const property = (value as Record<string, unknown>)[key];

  return Array.isArray(property) ? property.length : undefined;
}
