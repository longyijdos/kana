import { getArrayProperty, getBooleanProperty, getNumberProperty } from "../properties";

export function formatGlobOutput(result: object): string {
  const totalMatches = getNumberProperty(result, "totalMatches");
  const matches = getArrayProperty(result, "matches")?.length;
  const truncated = getBooleanProperty(result, "truncated");

  if (totalMatches === undefined || matches === undefined) {
    return "";
  }
  return `${matches} of ${totalMatches} matches${truncated ? " (truncated)" : ""}`;
}
