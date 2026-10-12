import {
  getArrayProperty,
  getBooleanProperty,
  getNumberProperty,
  getStringProperty,
} from "../properties";

export function formatGrepOutput(result: object): string {
  const path = getStringProperty(result, "path");
  const matches = getArrayProperty(result, "matches")?.length;
  const filesSearched = getNumberProperty(result, "filesSearched");
  const truncated = getBooleanProperty(result, "truncated");

  if (matches === undefined) {
    return path ?? "";
  }

  const location = path ? `${path}: ` : "";
  const files = filesSearched === undefined ? "" : ` in ${filesSearched} files`;

  return `${location}${matches} matches${files}${truncated ? " (truncated)" : ""}`;
}
