import type { UserMessage } from "@/core";
import type { ConversationRunSource } from "@/kana";
import { TextBlock, UserMessageBlock } from "../components";
import type { Component } from "../runtime";
import { tuiTheme } from "../theme";
import { formatUserMessage } from "./history";

// The transcript entry that announces a run, or undefined when the source has
// no visible input (compaction, or a user run without input).
export function createRunInputView(
  source: ConversationRunSource,
  input: UserMessage | undefined,
): Component | undefined {
  if (!input) return undefined;
  switch (source) {
    case "user":
      return new UserMessageBlock(input);
    case "goal":
      return input.provenance.kind === "goal_continuation"
        ? muted(`Goal continuation · round ${input.provenance.round}`)
        : new UserMessageBlock(input);
    case "scheduled":
      return muted(`Scheduled wake: ${stripHeader(input.content, "[Scheduled wake event]")}`);
    case "job":
      return muted(stripHeader(input.content, "[Background Job completion]"));
    case "subagent":
      return muted(stripHeader(input.content, "[Subagent completion]"));
    case "user_task":
      return muted(formatUserMessage(input));
    case "compaction":
      return undefined;
  }
}

function muted(text: string): TextBlock {
  return new TextBlock(text, { color: tuiTheme.muted });
}

function stripHeader(content: string, header: string): string {
  return content.startsWith(header) ? content.slice(header.length).replace(/^\n/, "") : content;
}
