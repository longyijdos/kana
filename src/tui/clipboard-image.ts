import type { UserImage } from "@/core";
import { encodeUserImage } from "@/utils";

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
  if (process.platform !== "darwin") {
    throw new Error(`Clipboard image paste is not supported on ${process.platform} yet.`);
  }

  const filePaths = await readMacOSClipboardFilePaths();
  if (filePaths.length > 0) {
    // Finder also publishes a TIFF representation of a copied file's icon.
    // Resolve image files first and never fall through to that bitmap when a
    // file reference is present.
    for (const path of filePaths) {
      const image = new Bun.Image(path);
      let metadata: Bun.Image.Metadata;
      try {
        metadata = await image.metadata();
      } catch {
        continue;
      }
      return encodeUserImage(image, metadata);
    }
    return undefined;
  }

  const image = Bun.Image.fromClipboard();
  if (!image) {
    return undefined;
  }
  return encodeUserImage(image, await image.metadata());
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
