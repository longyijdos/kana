import type { Static, TSchema } from "typebox";
import { precompileToolParameters, type ToolContext, type ToolResult } from "@/tools";
import { McpResponseError } from "./errors";
import {
  isJsonObject,
  type JsonObject,
  type McpCallToolResult,
  type McpProgress,
  type McpTool,
} from "./protocol";
import {
  type McpNormalizedToolResult,
  type McpToolResultLimits,
  type McpToolSource,
  normalizeMcpResponseError,
  normalizeMcpToolResult,
  resolveMcpToolResultLimits,
} from "./tool-result";

type McpToolCallOptions = {
  signal?: AbortSignal;
  onProgress?(progress: McpProgress): void;
};

export interface McpToolCaller {
  callTool(
    name: string,
    args?: JsonObject,
    options?: McpToolCallOptions,
  ): Promise<McpCallToolResult>;
}

export type RegisteredMcpToolOptions = {
  serverId: string;
  caller: McpToolCaller;
  tool: McpTool;
  resultLimits?: Partial<McpToolResultLimits>;
};

export type RegisteredMcpTool = {
  name: string;
  description: string;
  parameters: TSchema;
  source: McpToolSource;
  execute(
    args: Static<TSchema>,
    context: ToolContext,
  ): Promise<ToolResult<McpNormalizedToolResult>>;
};

type McpToolProgressResult = McpToolSource & {
  source: "mcp";
  progress: number;
  total?: number;
  message?: string;
};

export class McpToolSchemaError extends Error {
  constructor(serverId: string, remoteToolName: string, options?: ErrorOptions) {
    super(`MCP tool ${serverId}/${remoteToolName} has an unsupported input schema.`, options);
    this.name = "McpToolSchemaError";
  }
}

export function createRegisteredMcpTool(options: RegisteredMcpToolOptions): RegisteredMcpTool {
  if (!options.serverId.trim()) {
    throw new Error("MCP server ID cannot be empty.");
  }
  if (!options.tool.name.trim()) {
    throw new Error("MCP remote tool name cannot be empty.");
  }

  const source: McpToolSource = {
    serverId: options.serverId,
    remoteToolName: options.tool.name,
  };
  const parameters = options.tool.inputSchema as unknown as TSchema;
  const resultLimits = resolveMcpToolResultLimits(options.resultLimits);

  try {
    precompileToolParameters(parameters);
  } catch (error) {
    throw new McpToolSchemaError(options.serverId, options.tool.name, { cause: error });
  }

  return {
    name: options.tool.name,
    source,
    description: options.tool.description ?? "",
    parameters,
    async execute(args, context): Promise<ToolResult<McpNormalizedToolResult>> {
      if (!isJsonObject(args)) {
        throw new Error(
          `MCP tool ${options.serverId}/${options.tool.name} requires object arguments.`,
        );
      }

      try {
        const response = await options.caller.callTool(options.tool.name, args, {
          signal: context.signal,
          onProgress: (progress) => {
            const partialResult: McpToolProgressResult = {
              source: "mcp",
              ...source,
              progress: progress.progress,
              ...(progress.total === undefined ? {} : { total: progress.total }),
              ...(progress.message === undefined ? {} : { message: progress.message }),
            };
            context.update(partialResult);
          },
        });

        return normalizeMcpToolResult(response, source, resultLimits);
      } catch (error) {
        if (error instanceof McpResponseError) {
          return normalizeMcpResponseError(error, source, resultLimits);
        }
        throw error;
      }
    },
  };
}
