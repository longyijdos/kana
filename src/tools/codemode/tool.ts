import type { CodemodeResult } from "@earendil-works/pi-codemode";
import { type Static, Type } from "typebox";
import type { UserImage } from "@/core";
import { strictObject } from "../strict-object";
import type { Tool, ToolContext, ToolResult } from "../tool";
import { createCodemodeSandbox } from "./index";

const codemodeParameters = strictObject({ code: Type.String() });

export type CodemodeToolContext = ToolContext & {
  invokeTool(name: string, args: unknown, options?: { signal?: AbortSignal }): Promise<ToolResult>;
};

export function createCodemodeTool(options: { tools: readonly Tool[] }) {
  const tools = options.tools.filter((tool) => tool.name !== "run_code");

  return {
    name: "run_code",
    description:
      "Run JavaScript that calls tools with await tools.<name>(args). Output with text(), image(), or return. ALL_TOOLS lists available tools. Host filesystem, network, and module APIs are unavailable.",
    parameters: codemodeParameters,
    execution: { concurrency: "exclusive" },
    async execute({ code }: Static<typeof codemodeParameters>, context: CodemodeToolContext) {
      const invokeTool = context.invokeTool;
      const sandbox = createCodemodeSandbox({
        timeoutMs: Infinity,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          async execute(args, { signal }) {
            const result = await invokeTool(tool.name, args, { signal });
            if (result.isError) {
              throw new Error(result.content);
            }
            return result.result;
          },
        })),
      });

      try {
        const result = await sandbox.execute(code, { signal: context.signal });
        const text: string[] = [];
        const images: UserImage[] = [];
        for (const item of result.output) {
          if (item.type === "text") {
            text.push(item.text);
          } else {
            const metadata = await new Bun.Image(Buffer.from(item.data, "base64")).metadata();
            images.push({
              data: item.data,
              mimeType: item.mimeType as UserImage["mimeType"],
              width: metadata.width,
              height: metadata.height,
            });
          }
        }
        if (result.ok) {
          if (result.value !== undefined) {
            text.push(JSON.stringify(result.value));
          }
        } else {
          text.push(result.error.stack ?? result.error.message);
        }
        return {
          content: text.join("\n"),
          ...(images.length ? { images } : {}),
          result,
          isError: !result.ok,
        };
      } finally {
        await sandbox.close();
      }
    },
  } satisfies Tool<typeof codemodeParameters, CodemodeResult>;
}
