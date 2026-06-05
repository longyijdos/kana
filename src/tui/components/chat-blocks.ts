import type { AssistantMessage, ToolCallContent } from "../../core/messages";
import { color, dim } from "../render/ansi";
import type { Component } from "../runtime/component";
import { truncateToWidth } from "../render/width";
import { TextBlock } from "./text-block";

export class AssistantMessageBlock implements Component {
  private message: AssistantMessage = {
    role: "assistant",
    content: [],
  };

  update(message: AssistantMessage): void {
    this.message = message;
  }

  render(width: number): string[] {
    const lines: string[] = [""];
    let renderedContent = false;

    for (const content of this.message.content) {
      if (content.type === "text" && content.text.trim()) {
        lines.push(
          ...new TextBlock(content.text.trim(), {
            color: "green",
            prefix: "assistant: ",
          }).render(width),
        );
        renderedContent = true;
      }

      if (content.type === "thinking" && !renderedContent) {
        lines.push(dim("thinking..."));
      }
    }

    if (!renderedContent && this.message.stopReason) {
      lines.push(color(`assistant stopped: ${this.message.stopReason}`, "gray"));
    }

    return lines;
  }
}

export class ToolCallBlock implements Component {
  private executionStarted = false;
  private result?: unknown;
  private partialResult?: unknown;
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
    this.isError = isError;
    this.partialResult = undefined;
  }

  render(width: number): string[] {
    const state = this.result
      ? this.isError
        ? "failed"
        : "done"
      : this.executionStarted
        ? "running"
        : "pending";
    const titleColor = this.isError
      ? "red"
      : state === "done"
        ? "green"
        : "yellow";
    const lines = [
      "",
      color(`tool ${state}: ${formatToolActivity(this.toolCall)}`, titleColor),
    ];
    const output = formatToolOutput(this.result ?? this.partialResult);

    if (output) {
      lines.push(
        ...new TextBlock(output, {
          color: this.isError ? "red" : "gray",
        }).render(width),
      );
    }

    return lines.map((line) => truncateToWidth(line, width, ""));
  }
}

export class Transcript implements Component {
  readonly children: Component[] = [];

  constructor(private readonly maxRenderedLines = 400) {}

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

    return lines.slice(-this.maxRenderedLines);
  }
}

function formatToolActivity(toolCall: ToolCallContent): string {
  const path = getStringProperty(toolCall.args, "path");
  const command = getStringProperty(toolCall.args, "command");

  if (path) {
    return `${toolCall.name} ${path}`;
  }

  if (command) {
    return `${toolCall.name} ${command}`;
  }

  return toolCall.name;
}

function formatToolOutput(result: unknown): string {
  if (!result || typeof result !== "object") {
    return result === undefined ? "" : String(result);
  }

  const path = getStringProperty(result, "path");
  const command = getStringProperty(result, "command");
  const exitCode = getNumberProperty(result, "exitCode");
  const stdout = getStringProperty(result, "stdout");
  const stderr = getStringProperty(result, "stderr");
  const error = getStringProperty(result, "error");

  if (error) {
    return error;
  }

  if (command) {
    return [
      `${command}${exitCode === undefined ? "" : ` exit=${exitCode}`}`,
      stdout ? `stdout:\n${tail(stdout, 10)}` : undefined,
      stderr ? `stderr:\n${tail(stderr, 10)}` : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  if (path) {
    const lines = [
      getNumberProperty(result, "startLine") &&
      getNumberProperty(result, "endLine")
        ? `${path}:${getNumberProperty(result, "startLine")}-${getNumberProperty(result, "endLine")}`
        : path,
    ];
    const content = getStringProperty(result, "content");

    if (content) {
      lines.push(tail(content, 8));
    }

    return lines.join("\n");
  }

  return JSON.stringify(result, null, 2);
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

