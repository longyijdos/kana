import { escapeXml } from "../format";
import { loadKanaMemory } from "./storage";

export type FormatKanaMemoryPromptOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export function formatKanaMemoryForPrompt(
  options: FormatKanaMemoryPromptOptions = {},
): string | undefined {
  const globalMemory = loadKanaMemory("global", options).trim();
  const projectMemory = loadKanaMemory("project", options).trim();
  const memoryBlocks = [
    globalMemory ? formatMemoryBlock("global", globalMemory) : undefined,
    projectMemory ? formatMemoryBlock("project", projectMemory) : undefined,
  ].filter((block): block is string => block !== undefined);

  if (memoryBlocks.length === 0) {
    return undefined;
  }

  return ["<memory>", ...memoryBlocks, "</memory>"].join("\n");
}

function formatMemoryBlock(scope: "global" | "project", content: string): string {
  return [`<memory_reference scope="${scope}">`, escapeXml(content), "</memory_reference>"].join(
    "\n",
  );
}
