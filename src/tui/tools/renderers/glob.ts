import { getBooleanProperty, getNumberProperty, getStringProperty } from "../properties";

export function formatGlobOutput(result: object): string {
  const cwd = getStringProperty(result, "cwd");
  const pattern = getStringProperty(result, "pattern");
  const totalMatches = getNumberProperty(result, "totalMatches");
  const matches = readObjectArrayLength(result, "matches");
  const truncated = getBooleanProperty(result, "truncated");

  if (!pattern || totalMatches === undefined || matches === undefined) {
    return pattern ?? cwd ?? "";
  }

  const location = cwd && cwd !== "." ? `${cwd}/${pattern}` : pattern;

  return `${location}: ${matches} of ${totalMatches} matches${truncated ? " (truncated)" : ""}`;
}
function readObjectArrayLength(value: object, key: string): number | undefined {
  const property = (value as Record<string, unknown>)[key];

  return Array.isArray(property) ? property.length : undefined;
}
