import type { AssistantMessage, ToolCallContent } from "../../core/messages";
import { color, dim } from "../render/ansi";
import type { Component } from "../runtime/component";
import { truncateToWidth } from "../render/width";
import { TextBlock } from "./text-block";

const TOOL_OUTPUT_LINE_LIMIT = 8;

export class AssistantMessageBlock implements Component {
  private message: AssistantMessage = {
    role: "assistant",
    content: [],
  };

  update(message: AssistantMessage): void {
    this.message = message;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    let renderedContent = false;

    for (const content of this.message.content) {
      if (content.type === "text" && content.text.trim()) {
        lines.push(
          ...new TextBlock(content.text.trim(), {
            color: "green",
          }).render(width),
        );
        renderedContent = true;
      }

      if (content.type === "thinking" && !renderedContent) {
        lines.push(dim("thinking..."));
      }
    }

    return lines;
  }
}

export class ToolCallBlock implements Component {
  private executionStarted = false;
  private result?: unknown;
  private partialResult?: unknown;
  private hasResult = false;
  private isError = false;

  constructor(private readonly toolCall: ToolCallContent) {}

  updateArgs(args: unknown): void {
    this.toolCall.args = args;
  }

  markExecutionStarted(): void {
    this.executionStarted = true;
  }

  updatePartialResult(result: unknown): void {
    this.partialResult = result;
  }

  updateResult(result: unknown, isError: boolean): void {
    this.result = result;
    this.hasResult = true;
    this.isError = isError;
    this.partialResult = undefined;
  }

  render(width: number): string[] {
    const state = this.hasResult
      ? this.isError
        ? "failed"
        : "done"
      : this.executionStarted
        ? "running"
        : "preparing";
    const titleColor = this.isError
      ? "red"
      : state === "done"
        ? "green"
        : "yellow";
    const lines = [
      "",
      color(formatToolTitle(this.toolCall, state, this.result), titleColor),
    ];
    const output = formatToolOutput(
      this.toolCall,
      this.result ?? this.partialResult,
      this.isError,
    );

    if (typeof output === "string" && output) {
      lines.push(...renderOutput(output, width, this.isError ? "red" : "gray"));
    } else if (Array.isArray(output)) {
      lines.push(...output);
    }

    return lines.map((line) => truncateToWidth(line, width, ""));
  }
}

export class Transcript implements Component {
  readonly children: Component[] = [];

  addChild(component: Component): void {
    this.children.push(component);
  }

  clear(): void {
    this.children.length = 0;
  }

  render(width: number): string[] {
    const lines: string[] = [];

    for (const child of this.children) {
      lines.push(...child.render(width));
    }

    return lines;
  }
}

type ToolState = "preparing" | "running" | "done" | "failed";

function formatToolTitle(
  toolCall: ToolCallContent,
  state: ToolState,
  result: unknown,
): string {
  const target = toolTarget(toolCall, result);

  if (state === "preparing") {
    return `Preparing ${toolCall.name}...`;
  }

  if (state === "running") {
    return `${capitalize(formatRunningToolActivity(toolCall, target))}...`;
  }

  if (state === "failed") {
    return `Failed to ${formatToolAction(toolCall, target)}`;
  }

  switch (toolCall.name) {
    case "read":
      return `Read ${target}`;
    case "write":
      return `Created ${target}`;
    case "edit":
      return `Edited ${target}`;
    case "bash":
      return `Ran ${target}`;
    default:
      return `Used ${toolCall.name}`;
  }
}

function formatRunningToolActivity(toolCall: ToolCallContent, target: string): string {
  switch (toolCall.name) {
    case "read":
      return `reading ${target}`;
    case "write":
      return `creating ${target}`;
    case "edit":
      return `editing ${target}`;
    case "bash":
      return `running ${target}`;
    default:
      return `using ${toolCall.name}`;
  }
}

function formatToolAction(toolCall: ToolCallContent, target: string): string {
  switch (toolCall.name) {
    case "read":
      return `read ${target}`;
    case "write":
      return `create ${target}`;
    case "edit":
      return `edit ${target}`;
    case "bash":
      return `run ${target}`;
    default:
      return `use ${toolCall.name}`;
  }
}

function toolTarget(toolCall: ToolCallContent, result?: unknown): string {
  const path = getStringProperty(toolCall.args, "path");
  const resultPath = getStringProperty(result, "path");
  const command = getStringProperty(toolCall.args, "command");
  const resultCommand = getStringProperty(result, "command");

  if (resultPath || path) {
    return resultPath ?? path ?? toolCall.name;
  }

  if (resultCommand || command) {
    return resultCommand ?? command ?? toolCall.name;
  }

  return toolCall.name;
}

function formatToolOutput(
  toolCall: ToolCallContent,
  result: unknown,
  isError: boolean,
): string | string[] {
  if (!result || typeof result !== "object") {
    return result === undefined ? "" : String(result);
  }

  if (isError) {
    return formatErrorOutput(result);
  }

  switch (toolCall.name) {
    case "read":
      return formatReadOutput(result);
    case "write":
      return formatWriteOutput(toolCall, result);
    case "edit":
      return formatEditOutput(result);
    case "bash":
      return formatBashOutput(result);
  }

  return JSON.stringify(result, null, 2);
}

function formatErrorOutput(result: object): string {
  const error = getStringProperty(result, "error");

  return error ?? JSON.stringify(result, null, 2);
}

function formatReadOutput(result: object): string {
  const path = getStringProperty(result, "path");
  const content = getStringProperty(result, "content");
  const startLine = getNumberProperty(result, "startLine");
  const endLine = getNumberProperty(result, "endLine");
  const totalLines = getNumberProperty(result, "totalLines");
  const header =
    path && startLine !== undefined && endLine !== undefined && totalLines !== undefined
      ? `${path}:${startLine}-${endLine} of ${totalLines}`
      : path;

  return [header, content ? tail(content, TOOL_OUTPUT_LINE_LIMIT) : undefined]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatWriteOutput(toolCall: ToolCallContent, result: object): string {
  const content = getStringProperty(toolCall.args, "content");
  const bytesWritten = getNumberProperty(result, "bytesWritten");

  return [
    bytesWritten === undefined ? undefined : `${bytesWritten} bytes`,
    content ? tail(content, TOOL_OUTPUT_LINE_LIMIT) : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatEditOutput(result: object): string[] {
  const oldText = getStringProperty(result, "oldText");
  const newText = getStringProperty(result, "newText");
  const replacements = getNumberProperty(result, "replacements");
  const lines: string[] = [];

  if (replacements !== undefined) {
    lines.push(dim(`${replacements} replacement${replacements === 1 ? "" : "s"}`));
  }

  if (oldText !== undefined) {
    lines.push(...formatDiffLines(oldText, "red", "-"));
  }

  if (newText !== undefined) {
    lines.push(...formatDiffLines(newText, "green", "+"));
  }

  return lines;
}

function formatBashOutput(result: object): string {
  const exitCode = getNumberProperty(result, "exitCode");
  const stdout = getStringProperty(result, "stdout");
  const stderr = getStringProperty(result, "stderr");

  return [
    exitCode === undefined ? undefined : `exit ${exitCode}`,
    stdout ? `stdout:\n${tail(stdout, TOOL_OUTPUT_LINE_LIMIT)}` : undefined,
    stderr ? `stderr:\n${tail(stderr, TOOL_OUTPUT_LINE_LIMIT)}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatDiffLines(
  value: string,
  lineColor: "red" | "green",
  marker: "-" | "+",
): string[] {
  const lines = value.split("\n");

  if (lines.at(-1) === "") {
    lines.pop();
  }

  return (lines.length ? lines : [""]).map((line) => color(`${marker} ${line}`, lineColor));
}

function renderOutput(
  output: string,
  width: number,
  outputColor: "red" | "gray",
): string[] {
  return new TextBlock(output, {
    color: outputColor,
  }).render(width);
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}

function tail(value: string, limit: number): string {
  const lines = value.trimEnd().split("\n");
  const visible = lines.slice(-limit);
  const hidden = lines.length - visible.length;

  return hidden > 0
    ? `... ${hidden} more lines\n${visible.join("\n")}`
    : visible.join("\n");
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }

  const property = value[key as keyof typeof value];

  return typeof property === "string" ? property : undefined;
}

function getNumberProperty(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }

  const property = value[key as keyof typeof value];

  return typeof property === "number" ? property : undefined;
}
