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
      description: `List the available tools and full input schemas for an enabled MCP server. This only reads the catalog; it does not enable servers or grant permissions. Read again whenever schemas are needed, including after context compaction. Follow nextOffset to read more tools; read any saved artifact to obtain complete schemas.\n\nAvailable MCP servers:\n${catalog}`,
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
          server: name,
          tools: tools.slice(offset, nextOffset).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
          })),
          ...(nextOffset < tools.length ? { nextOffset } : {}),
        };
      },
    },
    {
      name: "mcp_call",
      description:
        "Call a tool on an enabled MCP server. Use mcp_list_tools to read the tool's input schema before calling it. The arguments object must satisfy that schema. Loading a catalog does not change the available servers or tools.",
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
