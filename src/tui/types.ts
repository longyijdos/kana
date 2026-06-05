export type LogLine = {
  id: number;
  tone: "muted" | "user" | "assistant" | "thinking" | "tool" | "error";
  text: string;
};

export type RunStatus = {
  phase:
    | "idle"
    | "starting"
    | "thinking"
    | "responding"
    | "tool"
    | "done"
    | "aborted"
    | "error"
    | "length";
  turn?: number;
  maxTurns?: number;
  activeTool?: string;
};
