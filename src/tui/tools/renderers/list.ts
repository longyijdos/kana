import {
  getArrayProperty,
  getBooleanProperty,
  getNumberProperty,
  getStringProperty,
} from "../properties";

export function formatListOutput(result: object): string {
  const path = getStringProperty(result, "path");
  const totalEntries = getNumberProperty(result, "totalEntries");
  const entries = getArrayProperty(result, "entries")?.length;
  const truncated = getBooleanProperty(result, "truncated");

  if (!path || totalEntries === undefined || entries === undefined) {
    return path ?? "";
  }

  return `${path}: ${entries} of ${totalEntries} entries${truncated ? " (truncated)" : ""}`;
}
