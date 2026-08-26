export type ToolState = "running" | "done" | "failed" | "canceled";

export type ToolOutputDetail = "compact" | "full";

export type ToolTranscriptTitle = {
  activity: string;
  hint?: string;
  target?: string;
};

export type ToolApprovalText = {
  title: string;
  detail: string;
};
