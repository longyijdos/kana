import React from "react";
import { Box, Text } from "ink";
import type { RunStatus } from "./types";

const SEPARATOR = " · ";

export function StatusLine({
  status,
  model,
  isRunning,
}: {
  status: RunStatus;
  model: string;
  isRunning: boolean;
}) {
  const turn = status.turn
    ? `turn ${status.turn}${status.maxTurns ? `/${status.maxTurns}` : ""}`
    : undefined;
  const cwd = formatCwd(process.cwd());

  return (
    <Box paddingX={1}>
      <Text color="cyan">{model}</Text>
      <Text color="gray">{SEPARATOR}</Text>
      <Text color={phaseColor(status.phase)}>{phaseLabel(status.phase)}</Text>
      {turn ? (
        <>
          <Text color="gray">{SEPARATOR}</Text>
          <Text color="white">{turn}</Text>
        </>
      ) : null}
      {status.activeTool ? (
        <>
          <Text color="gray">{SEPARATOR}</Text>
          <Text color="yellow">tool {status.activeTool}</Text>
        </>
      ) : null}
      <Text color="gray">{SEPARATOR}</Text>
      <Text color="green">{cwd}</Text>
      <Text color="gray">{SEPARATOR}</Text>
      <Text color={isRunning ? "yellow" : "white"}>
        {isRunning ? "Ctrl+C abort" : "Ctrl+C exit"}
      </Text>
    </Box>
  );
}

function phaseLabel(phase: RunStatus["phase"]): string {
  switch (phase) {
    case "idle":
      return "idle";
    case "starting":
      return "starting";
    case "thinking":
      return "thinking";
    case "responding":
      return "responding";
    case "tool":
      return "tool";
    case "done":
      return "done";
    case "aborted":
      return "aborted";
    case "error":
      return "error";
    case "length":
      return "length limit";
  }
}

function phaseColor(phase: RunStatus["phase"]): string {
  switch (phase) {
    case "error":
    case "aborted":
    case "length":
      return "red";
    case "tool":
    case "starting":
    case "thinking":
    case "responding":
      return "yellow";
    case "idle":
    case "done":
      return "white";
  }
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME;

  if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
    return `~${cwd.slice(home.length)}`;
  }

  return cwd;
}
