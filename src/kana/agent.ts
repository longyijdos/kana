import { Agent, type AgentConfig } from "@/agent";
import {
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createListTool,
  createReadTool,
  createRememberTool,
  createScheduleWakeTool,
  createWriteTool,
} from "@/tools";
import type { KanaConfig } from "./config";
import { createKanaModel } from "./model";
import { buildKanaSystemPrompt } from "./prompt";
import { loadKanaSkills } from "./skills";
import type { WakeScheduler } from "./wake-scheduler";

type KanaAgentOptions = Pick<
  AgentConfig,
  "beforeToolExecution" | "messages" | "onRunCommitted" | "logger"
> & {
  wakeScheduler?: WakeScheduler;
  sessionId?: string;
};

export function createKanaAgent(config: KanaConfig, options: KanaAgentOptions = {}): Agent {
  const cwd = process.cwd();
  const { skills } = loadKanaSkills({ cwd });
  const model = createKanaModel(config, options.logger);

  return new Agent({
    model,
    system: buildKanaSystemPrompt({ cwd, skills }),
    tools: [
      createListTool({
        root: cwd,
      }),
      createGlobTool({
        root: cwd,
      }),
      createGrepTool({
        root: cwd,
      }),
      createReadTool({
        root: cwd,
      }),
      createWriteTool({
        root: cwd,
      }),
      createEditTool({
        root: cwd,
      }),
      createBashTool({
        root: cwd,
      }),
      ...(config.memory.enabled
        ? [
            createRememberTool({
              cwd,
            }),
          ]
        : []),
      ...(options.wakeScheduler && options.sessionId
        ? [
            createScheduleWakeTool({
              scheduler: options.wakeScheduler,
              sessionId: options.sessionId,
            }),
          ]
        : []),
    ],
    maxTurns: config.agent.maxTurns,
    beforeToolExecution: options.beforeToolExecution,
    messages: options.messages,
    onRunCommitted: options.onRunCommitted,
    logger: options.logger,
    loggerMetadata: { agentKind: "conversation" },
  });
}
