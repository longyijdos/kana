import type { Message } from "@/core";
import type { KanaSubagentInspection } from "@/kana";
import { tuiTheme } from "../theme";
import {
  HostedToolBlock,
  MarkdownBlock,
  TextBlock,
  ToolCallBlock,
  Transcript,
} from "./chat-blocks";
import type { ContentView } from "./content-viewer";

export type SubagentInspectionOptions = {
  hyperlinks?: boolean;
  renderLatex?: boolean;
  renderMermaid?: boolean;
};

export function createSubagentInspectionView(
  inspection: KanaSubagentInspection,
  options: SubagentInspectionOptions = {},
): ContentView {
  const results = new Map<string, Extract<Message, { role: "tool" }>>();
  for (const message of inspection.messages) {
    if (message.role === "tool") results.set(message.toolCallId, message);
  }

  const transcript = new Transcript();
  for (const message of inspection.messages) {
    if (message.role !== "assistant") continue;
    for (const [index, content] of message.content.entries()) {
      if (content.type === "text" && content.text.trim()) {
        const complete = message.stopReason !== undefined || index < message.content.length - 1;
        transcript.addChild(new MarkdownBlock(content.text.trim(), { ...options, complete }));
      } else if (content.type === "hosted_tool") {
        transcript.addChild(new HostedToolBlock(content, Date.now, { summaryOnly: true }));
      } else if (content.type === "tool_call") {
        const block = new ToolCallBlock(content, Date.now, { summaryOnly: true });
        const result = results.get(content.id);
        if (result) {
          block.updateResult(result.result ?? result.artifact ?? result.content, result.isError);
        } else if (inspection.status !== "running") {
          block.markCanceled();
        }
        transcript.addChild(block);
      }
    }
  }

  if (inspection.error) {
    transcript.addChild(
      new TextBlock(inspection.error, { color: tuiTheme.error, prefix: "Error: " }),
    );
  }

  return {
    title: `Subagent ${inspection.profile} · ${inspection.status}`,
    render: (width) => [`Task: ${inspection.task}`, "", ...transcript.render(width)],
  };
}
