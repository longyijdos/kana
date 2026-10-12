import type { Message } from "@/core";
import type { AgentContext, AgentEventSink, AgentLoopConfig } from "../../src/agent/loop";
import { runAgentLoop } from "../../src/agent/loop";
import { type AgentSettingsOptions, resolveAgentSettings } from "../../src/agent/settings";
import type { ToolResultPolicy } from "../../src/agent/tool-result-policy";

export type TestLoopOptions = AgentSettingsOptions &
  Omit<AgentLoopConfig, "settings"> & { toolResultPolicy?: ToolResultPolicy };

export function runTestLoop(
  context: AgentContext,
  options: TestLoopOptions,
  emit: AgentEventSink,
): Promise<Message[]> {
  const {
    model,
    maxTurns,
    toolDeadlineMs,
    webSearch,
    imageInput,
    parallelToolCalls,
    maxParallelToolCalls,
    toolResultPolicy,
    ...config
  } = options;
  return runAgentLoop(
    context,
    {
      ...config,
      settings: resolveAgentSettings({
        model,
        maxTurns,
        toolDeadlineMs,
        webSearch,
        imageInput,
        parallelToolCalls,
        maxParallelToolCalls,
      }),
      toolResultPolicies: [
        ...(toolResultPolicy ? [toolResultPolicy] : []),
        ...(config.toolResultPolicies ?? []),
      ],
    },
    emit,
  );
}
