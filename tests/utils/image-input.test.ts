import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadUserImageFile } from "@/utils";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("image input", () => {
  test("loads quoted local paths and normalizes them into a provider-ready image", async () => {
    const tempDir = createTempDir();
    const imagePath = path.join(tempDir, "image with spaces.png");
    writeFileSync(imagePath, PNG_1X1);

    const image = await loadUserImageFile(`"${imagePath}"`);

    expect(image).toMatchObject({
      mimeType: "image/png",
      width: 1,
      height: 1,
    });
    expect(Buffer.from(image.data, "base64").subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  test("reports unreadable paths without exposing decoder internals", async () => {
    const missing = path.join(createTempDir(), "missing.png");

    await expect(loadUserImageFile(missing)).rejects.toThrow(
      `Unable to read image file: ${missing}`,
    );
  });
});

function createTempDir(): string {
  const tempDir = mkdtempSync(path.join(tmpdir(), "kana-image-input-"));
  tempDirs.push(tempDir);
  return tempDir;
}
