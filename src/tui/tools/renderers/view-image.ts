import { formatByteSize } from "../../render";
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
