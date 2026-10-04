import { getBooleanProperty, getNumberProperty, getStringProperty } from "../properties";

export function formatGrepOutput(result: object): string {
  const path = getStringProperty(result, "path");
  const matches = readObjectArrayLength(result, "matches");
  const filesSearched = getNumberProperty(result, "filesSearched");
  const truncated = getBooleanProperty(result, "truncated");

  if (matches === undefined) {
    return path ?? "";
  }

  const location = path ? `${path}: ` : "";
  const files = filesSearched === undefined ? "" : ` in ${filesSearched} files`;

  return `${location}${matches} matches${files}${truncated ? " (truncated)" : ""}`;
}
function readObjectArrayLength(value: object, key: string): number | undefined {
  const property = (value as Record<string, unknown>)[key];

  return Array.isArray(property) ? property.length : undefined;
}
