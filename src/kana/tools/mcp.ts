import { Type } from "typebox";
import type { McpToolRegistry } from "@/mcp";
import { strictObject, type Tool, validateToolArguments } from "@/tools";

export function createMcpTools(registry: McpToolRegistry): Tool[] {
  const catalog = registry.catalog
    .map(({ name, description }) => `- ${name}${description ? `: ${description}` : ""}`)
    .join("\n");

  return [
    {
      name: "mcp_list_tools",
      outputSchema: Type.Object({
        tools: Type.Array(
          Type.Object({
            name: Type.String(),
            description: Type.String(),
          }),
        ),
        nextOffset: Type.Optional(Type.Number()),
      }),
      description: `List tool names and descriptions for an enabled MCP server.\n\nAvailable MCP servers:\n${catalog}`,
      parameters: strictObject({
        name: Type.String({ description: "MCP server name from the catalog." }),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      }),
      execution: { concurrency: "parallel" },
      execute({ name, offset = 0, limit = 20 }) {
        if (!registry.catalog.some((server) => server.name === name)) {
          throw new Error(`MCP server "${name}" is not available.`);
        }
        const tools = registry.listTools(name);
        const nextOffset = offset + limit;
        return {
          tools: tools.slice(offset, nextOffset).map((tool) => ({
            name: tool.name,
            description: tool.description,
          })),
          ...(nextOffset < tools.length ? { nextOffset } : {}),
        };
      },
    },
    {
      name: "mcp_get_tool",
      outputSchema: Type.Object({
        inputSchema: Type.Record(Type.String(), Type.Unknown()),
        outputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      }),
      description: "Get a tool's input schema from an enabled MCP server.",
      parameters: strictObject({
        server: Type.String(),
        tool: Type.String(),
      }),
      execution: { concurrency: "parallel" },
      execute({ server, tool: name }) {
        const tool = registry.getTool(server, name);
        if (!tool) {
          throw new Error(`MCP tool "${server}/${name}" is not available.`);
        }
        const definition = {
          inputSchema: tool.parameters,
        };
        return {
          content: JSON.stringify(definition),
          result: {
            ...definition,
            ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
          },
        };
      },
    },
    {
      name: "mcp_call",
      description: "Call a tool on an enabled MCP server. Arguments must match its input schema.",
      parameters: strictObject({
        server: Type.String(),
        tool: Type.String(),
        arguments: Type.Object({}, { additionalProperties: true }),
      }),
      async execute({ server, tool: name, arguments: args }, context) {
        const tool = registry.getTool(server, name);
        if (!tool) {
          throw new Error(`MCP tool "${server}/${name}" is not available.`);
        }
        return tool.execute(validateToolArguments(tool, args), context);
      },
    },
  ];
}
