import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createViewImageTool } from "../../src/tools/view-image";
import {
  createToolContext,
  createWorkspaceToolFixture,
  expectToolResult,
} from "./workspace-fixture";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const { cleanupTempRoots, createTempRoot } = createWorkspaceToolFixture();

describe("view_image tool", () => {
  afterEach(cleanupTempRoots);

  test("loads a workspace image as a visual tool observation", async () => {
    const root = await createTempRoot();
    const imagePath = path.join(root, "screenshots", "result.png");
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(imagePath, PNG_1X1);
    const viewImage = createViewImageTool({ root });

    const result = await viewImage.execute({ path: "screenshots/result.png" }, createToolContext());

    expectToolResult(result);
    expect(result.result).toEqual({
      path: path.join("screenshots", "result.png"),
      mimeType: "image/png",
      width: 1,
      height: 1,
      byteSize: 70,
    });
    expect(result.content).toContain("dimensions: 1x1");
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0]).toMatchObject({ mimeType: "image/png", width: 1, height: 1 });
    expect(Buffer.from(result.images?.[0]?.data ?? "", "base64").subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  test("rejects paths that do not resolve to image files", async () => {
    const root = await createTempRoot();
    await mkdir(path.join(root, "screenshots"));
    const viewImage = createViewImageTool({ root });

    await expect(viewImage.execute({ path: "screenshots" }, createToolContext())).rejects.toThrow(
      "Path is not a file",
    );
  });
});
