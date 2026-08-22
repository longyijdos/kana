import { getNumberProperty, getStringProperty } from "../properties";

export function formatViewImageOutput(result: object): string {
  const mimeType = getStringProperty(result, "mimeType");
  const width = getNumberProperty(result, "width");
  const height = getNumberProperty(result, "height");
  const byteSize = getNumberProperty(result, "byteSize");
  const format = mimeType?.startsWith("image/")
    ? mimeType.slice("image/".length).toUpperCase()
    : mimeType;
  const dimensions = width !== undefined && height !== undefined ? `${width}×${height}` : undefined;

  return [format, dimensions, byteSize === undefined ? undefined : formatByteSize(byteSize)]
    .filter((detail): detail is string => detail !== undefined)
    .join(" · ");
}

export function hasExpandableViewImageOutput(): boolean {
  return false;
}

function formatByteSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
