import React from "react";
import { Box, Text } from "ink";
import type { PromptCommand } from "./commands";

export function CommandPalette({
  commands,
  selectedIndex,
}: {
  commands: PromptCommand[];
  selectedIndex: number;
}) {
  if (!commands.length) {
    return (
      <Box paddingX={1}>
        <Text color="red">No matching commands</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {commands.map((command, index) => (
        <Text key={command.name} color={index === selectedIndex ? "yellow" : "white"}>
          {index === selectedIndex ? "> " : "  "}/{command.name}
          <Text color="gray"> - </Text>
          <Text color="white">{command.description}</Text>
        </Text>
      ))}
    </Box>
  );
}
