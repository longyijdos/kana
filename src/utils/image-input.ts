import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { UserImage, UserImageMimeType } from "@/core";

export const MAX_IMAGE_INPUT_BYTES = 10 * 1024 * 1024;

const MAX_IMAGE_INPUT_DIMENSION = 2048;

export async function loadUserImageFile(value: string): Promise<UserImage> {
  const path = resolveUserImagePath(value);
  const image = new Bun.Image(path);
  let metadata: Bun.Image.Metadata;
  try {
    metadata = await image.metadata();
  } catch (error) {
    throw new Error(`Unable to read image file: ${value}`, { cause: error });
  }
  return encodeUserImage(image, metadata);
}

export async function encodeUserImage(
  image: Bun.Image,
  metadata: Bun.Image.Metadata,
): Promise<UserImage> {
  // Normalize clipboard and path inputs before persistence so provider adapters
  // receive the same bounded bytes and sessions do not retain oversized originals.
  image.resize(MAX_IMAGE_INPUT_DIMENSION, MAX_IMAGE_INPUT_DIMENSION, {
    fit: "inside",
    withoutEnlargement: true,
  });

  const mimeType = selectOutputFormat(image, metadata.format);
  const bytes = await image.bytes();
  if (bytes.length > MAX_IMAGE_INPUT_BYTES) {
    throw new Error(`Image exceeds Kana's ${formatByteSize(MAX_IMAGE_INPUT_BYTES)} limit.`);
  }

  return {
    mimeType,
    data: Buffer.from(bytes).toString("base64"),
    width: image.width,
    height: image.height,
  };
}

function resolveUserImagePath(value: string): string {
  let path = value.trim();
  if (
    path.length >= 2 &&
    ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'")))
  ) {
    path = path.slice(1, -1);
  }
  if (!path) {
    throw new Error("Image path cannot be empty.");
  }
  if (path.startsWith("file://")) {
    try {
      return fileURLToPath(path);
    } catch (error) {
      throw new Error(`Invalid image file URL: ${value}`, { cause: error });
    }
  }
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    path = resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

function selectOutputFormat(image: Bun.Image, format: Bun.Image.Format): UserImageMimeType {
  // Preserve formats accepted by provider adapters; Bun's other clipboard and
  // file decoders are normalized to PNG because they are not portable inputs.
  switch (format) {
    case "jpeg":
      image.jpeg({ quality: 85 });
      return "image/jpeg";
    case "webp":
      image.webp({ quality: 85 });
      return "image/webp";
    case "png":
      image.png();
      return "image/png";
    case "avif":
    case "bmp":
    case "gif":
    case "heic":
    case "tiff":
      image.png();
      return "image/png";
  }
}

function formatByteSize(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
