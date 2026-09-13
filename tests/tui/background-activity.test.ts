import { describe, expect, test } from "bun:test";
import type { BackgroundJobClient, BackgroundJobSummary } from "@/jobs";
import type { KanaSubagentClient, KanaSubagentSummary } from "@/kana";
import { KanaTuiApp } from "../../src/tui/app/app";
import type { Editor } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import {
  type BackgroundClientStub,
  createBackgroundClient,
  jobSummary,
  subagentSummary,
} from "../helpers/background-activity";
import {
  createTerminalStub as createTerminal,
  createTuiAgentStub,
  createTuiAppOptions,
} from "./app-fixture";

describe("background activity strip", () => {
  test("follows the active session's running work", async () => {
    const sessions = new Map<string, SessionClients>();
    sessions.set("session-a", createSessionClients());
    sessions.set("new", createSessionClients());
    const sessionA = sessions.get("session-a") as SessionClients;
    const sessionB = sessions.get("new") as SessionClients;
    sessionA.subagents.items.push(
      subagentSummary("agent_3f2a1b7c9d", "running", "reviewer: Check the parser"),
    );

    const appOptions = createTuiAppOptions();
    const app = new KanaTuiApp(() => createTuiAgentStub(), createTerminal(), {
      ...appOptions,
      conversation: {
        ...appOptions.conversation,
        initialSession: { id: "session-a", messages: [], timeline: [] },
        getBackgroundJobs: (sessionId) =>
          sessions.get(sessionId)?.jobs as unknown as BackgroundJobClient | undefined,
        getSubagents: (sessionId) =>
          sessions.get(sessionId)?.subagents as unknown as KanaSubagentClient | undefined,
      },
    });
    const internal = app as unknown as {
      editor: Editor;
      handleCommand(command: { name: string; arguments: string; raw: string }): void;
    };
    const rendered = () => stripAnsi(internal.editor.render(96).join("\n"));

    expect(rendered()).toContain("Background · 1");
    expect(rendered()).toContain("reviewer: Check the parser");

    internal.handleCommand({ name: "new", arguments: "", raw: "/new" });
    await waitFor(() => !rendered().includes("Background"));

    sessionA.jobs.items.push(jobSummary("job_82ac19de00", "running", "bun test"));
    sessionA.jobs.emit(jobEvent("session-a"));
    expect(rendered()).not.toContain("bun test");

    sessionB.jobs.items.push(jobSummary("job_5511dd0e77", "running", "bun lint"));
    sessionB.jobs.emit(jobEvent("new"));
    expect(rendered()).toContain("bun lint");
  });
});

// The conversation runtime subscribes to the same clients, so stub events must
// stay shaped like real completion events instead of bare notifications.
function jobEvent(sessionId: string): unknown {
  return {
    type: "observed",
    owner: { sessionId, instanceId: `instance-${sessionId}` },
    job: { id: `job_${sessionId}` },
  };
}

type SessionClients = {
  subagents: BackgroundClientStub<KanaSubagentSummary>;
  jobs: BackgroundClientStub<BackgroundJobSummary>;
};

function createSessionClients(): SessionClients {
  return {
    subagents: createBackgroundClient<KanaSubagentSummary>(),
    jobs: createBackgroundClient<BackgroundJobSummary>(),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }

  throw new Error("Condition was not met.");
}
