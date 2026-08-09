import type { UserImage, UserImageMimeType } from "@/core";

export const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;

const MAX_CLIPBOARD_IMAGE_DIMENSION = 2048;

const MACOS_CLIPBOARD_FILE_PATHS_SCRIPT = `
ObjC.import("AppKit");
ObjC.import("Foundation");

function run() {
  const pasteboard = $.NSPasteboard.generalPasteboard;
  const paths = [];
  const filenames = pasteboard.propertyListForType("NSFilenamesPboardType");
  if (!filenames.isNil()) {
    for (let index = 0; index < Number(filenames.count); index += 1) {
      paths.push(ObjC.unwrap(filenames.objectAtIndex(index)));
    }
  }

  if (paths.length === 0) {
    const fileURLValue = pasteboard.stringForType("public.file-url");
    if (!fileURLValue.isNil()) {
      const fileURL = $.NSURL.URLWithString(fileURLValue);
      if (!fileURL.isNil() && ObjC.unwrap(fileURL.scheme) === "file") {
        const pathURL = fileURL.filePathURL;
        if (!pathURL.isNil()) {
          paths.push(ObjC.unwrap(pathURL.path));
        }
      }
    }
  }

  return JSON.stringify(paths);
}
`;

export async function readClipboardImage(): Promise<UserImage | undefined> {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error(`Clipboard image paste is not supported on ${process.platform} yet.`);
  }

  if (process.platform === "darwin") {
    const filePaths = await readMacOSClipboardFilePaths();
    if (filePaths.length > 0) {
      // Finder also publishes a TIFF representation of a copied file's icon.
      // Resolve image files first and never fall through to that bitmap when a
      // file reference is present.
      for (const path of filePaths) {
        const metadata = await readImageMetadata(path);
        if (metadata) {
          return encodeClipboardImage(new Bun.Image(path), metadata);
        }
      }
      return undefined;
    }
  }

  const image = Bun.Image.fromClipboard();
  if (!image) {
    return undefined;
  }
  return encodeClipboardImage(image, await image.metadata());
}

async function readMacOSClipboardFilePaths(): Promise<string[]> {
  const child = Bun.spawn(
    ["osascript", "-l", "JavaScript", "-e", MACOS_CLIPBOARD_FILE_PATHS_SCRIPT],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, output, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  if (exitCode !== 0) {
    const detail = stderr.trim().replace(/\s+/g, " ").slice(0, 300);
    throw new Error(
      detail
        ? `macOS clipboard file probe failed: ${detail}`
        : `macOS clipboard file probe exited with code ${exitCode}.`,
    );
  }

  const value: unknown = JSON.parse(output.trim() || "[]");
  if (!Array.isArray(value) || !value.every((path) => typeof path === "string")) {
    throw new Error("macOS clipboard file probe returned invalid paths.");
  }
  return value;
}

async function readImageMetadata(path: string): Promise<Bun.Image.Metadata | undefined> {
  try {
    return await new Bun.Image(path).metadata();
  } catch {
    return undefined;
  }
}

async function encodeClipboardImage(
  image: Bun.Image,
  metadata: Bun.Image.Metadata,
): Promise<UserImage> {
  image.resize(MAX_CLIPBOARD_IMAGE_DIMENSION, MAX_CLIPBOARD_IMAGE_DIMENSION, {
    fit: "inside",
    withoutEnlargement: true,
  });

  const mimeType = selectOutputFormat(image, metadata.format);
  const bytes = await image.bytes();
  if (bytes.length > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new Error(
      `Clipboard image exceeds Kana's ${formatByteSize(MAX_CLIPBOARD_IMAGE_BYTES)} limit.`,
    );
  }

  return {
    mimeType,
    data: Buffer.from(bytes).toString("base64"),
    width: image.width,
    height: image.height,
  };
}

function selectOutputFormat(image: Bun.Image, format: Bun.Image.Format): UserImageMimeType {
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
