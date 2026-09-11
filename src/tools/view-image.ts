import path from "node:path";
import { Type } from "typebox";

import type { UserImageMimeType } from "@/core";
import { loadUserImageFile } from "@/utils";
import { strictObject } from "./strict-object";
import type { Tool } from "./tool";
import { resolveExistingWorkspaceFile } from "./workspace-path";

export const viewImageParameters = strictObject({
  path: Type.String({
    description: "Image path to inspect, relative to the workspace root or absolute.",
  }),
});

export type ViewImageToolResult = {
  path: string;
  mimeType: UserImageMimeType;
  width: number;
  height: number;
  byteSize: number;
};

export type ViewImageToolOptions = {
  root?: string;
};

export function createViewImageTool(
  options: ViewImageToolOptions = {},
): Tool<typeof viewImageParameters, ViewImageToolResult> {
  const root = path.resolve(options.root ?? process.cwd());

  return {
    name: "view_image",
    description:
      "Load a local image as a visual observation. Use this to inspect screenshots, charts, and image assets directly.",
    parameters: viewImageParameters,
    execution: {
      concurrency: "parallel",
    },
    execute: async (args) => {
      const filePath = await resolveExistingWorkspaceFile(root, args.path);
      const image = await loadUserImageFile(filePath.absolutePath);
      const result: ViewImageToolResult = {
        path: filePath.relativePath,
        mimeType: image.mimeType,
        width: image.width,
        height: image.height,
        byteSize: Buffer.byteLength(image.data, "base64"),
      };

      return {
        content: formatViewImageContent(result),
        images: [image],
        result,
      };
    },
  };
}

function formatViewImageContent(result: ViewImageToolResult): string {
  return [
    `path: ${result.path}`,
    `mime_type: ${result.mimeType}`,
    `dimensions: ${result.width}x${result.height}`,
    `bytes: ${result.byteSize}`,
  ].join("\n");
}
