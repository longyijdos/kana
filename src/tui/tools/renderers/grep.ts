import { getBooleanProperty, getNumberProperty, getStringProperty } from "../properties";

export function formatGrepOutput(result: object): string {
  const path = getStringProperty(result, "path");
  const pattern = getStringProperty(result, "pattern");
  const matches = readObjectArrayLength(result, "matches");
  const filesSearched = getNumberProperty(result, "filesSearched");
  const truncated = getBooleanProperty(result, "truncated");

  if (!pattern || matches === undefined) {
    return pattern ?? path ?? "";
  }

  const location = path ? `${path}: ` : "";
  const files = filesSearched === undefined ? "" : ` in ${filesSearched} files`;

  return `${location}${matches} matches${files} for ${pattern}${truncated ? " (truncated)" : ""}`;
}
function readObjectArrayLength(value: object, key: string): number | undefined {
  const property = (value as Record<string, unknown>)[key];

  return Array.isArray(property) ? property.length : undefined;
}
