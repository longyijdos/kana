import type { Model } from "../core/model";
import type { Message } from "../core/messages";
import type { Tool } from "../tools/tool";

export type AgentConfig = {
  model: Model;
  system?: string;
  messages?: Message[];
  tools?: Tool[];
  // Prevent accidental infinite tool loops while keeping the first version
  // free of custom stop hooks.
  maxTurns?: number;
  signal?: AbortSignal;
};

export type AgentRunInput =
  | string
  | {
      message: string;
    };
