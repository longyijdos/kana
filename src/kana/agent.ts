import { Agent, type AgentConfig } from "@/agent";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createRememberTool,
  createWriteTool,
} from "@/tools";
import type { KanaConfig } from "./config";
import { createKanaModel } from "./model";
import { buildKanaSystemPrompt } from "./prompt";
import { loadKanaSkills } from "./skills";

type KanaAgentOptions = Pick<AgentConfig, "beforeToolExecution" | "messages" | "onRunCommitted">;

export function createKanaAgent(config: KanaConfig, options: KanaAgentOptions = {}): Agent {
  const cwd = process.cwd();
  const { skills } = loadKanaSkills({ cwd });
  const model = createKanaModel(config);

  return new Agent({
    model,
    system: buildKanaSystemPrompt({ cwd, skills }),
    tools: [
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
    ],
    maxTurns: config.agent.maxTurns,
    beforeToolExecution: options.beforeToolExecution,
    messages: options.messages,
    onRunCommitted: options.onRunCommitted,
  });
}
