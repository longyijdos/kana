import {
  type CodemodeJsonSchema,
  type CodemodeResult,
  renderToolOutputType,
  renderToolSample,
  toCodemodeIdentifier,
} from "@earendil-works/pi-codemode";
import { type Static, Type } from "typebox";
import type { UserImage } from "@/core";
import { strictObject } from "../strict-object";
import type { Tool, ToolContext, ToolResult } from "../tool";
import { createCodemodeSandbox } from "./index";

const codemodeParameters = strictObject({ code: Type.String() });

export type CodemodeToolContext = ToolContext & {
  invokeTool(name: string, args: unknown, options?: { signal?: AbortSignal }): Promise<ToolResult>;
};

export function createCodemodeTool(options: { tools: readonly Tool[]; mode?: "mixed" | "only" }) {
  const tools = options.tools.filter((tool) => tool.name !== "run_code");
  const definitions = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as unknown as CodemodeJsonSchema,
    outputSchema: tool.outputSchema as CodemodeJsonSchema | undefined,
  }));
  const declarations =
    options.mode === "only"
      ? definitions.map((tool) => renderToolSample(tool)).join("\n\n")
      : [
          "```ts",
          "type ToolResults = {",
          ...definitions.map(
            (tool) =>
              `  ${toCodemodeIdentifier(tool.name)}: ${renderToolOutputType(tool.outputSchema)};`,
          ),
          "};",
          "```",
        ].join("\n");

  return {
    name: "run_code",
    description: [
      "Run JavaScript that calls tools with await tools.<name>(args). Calls resolve to each tool's structured result and failures throw an Error. Output with text(), image(), or return. Tool images are forwarded automatically. ALL_TOOLS lists available tools. Host filesystem, network, module APIs, and timers are unavailable.",
      options.mode === "only"
        ? "The TypeScript declarations below describe the API; write JavaScript in code."
        : "The TypeScript declarations below describe each tool's return value; write JavaScript in code. ToolResults entries correspond to tools with the same names.",
      declarations,
    ].join("\n\n"),
    parameters: codemodeParameters,
    execution: { concurrency: "exclusive", deadlineMs: 15 * 60 * 1000 },
    async execute({ code }: Static<typeof codemodeParameters>, context: CodemodeToolContext) {
      const invokeTool = context.invokeTool;
      const images: UserImage[] = [];
      const sandbox = createCodemodeSandbox({
        timeoutMs: Infinity,
        tools: definitions.map((tool) => ({
          ...tool,
          async execute(args, { signal }) {
            const result = await invokeTool(tool.name, args, { signal });
            if (result.images) images.push(...result.images);
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
