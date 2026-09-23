import { describe, expect, test } from "bun:test";
import { createMessageIdentity } from "../../src/core";
import type { ConversationRuntimeEvent } from "../../src/kana";
import { KanaTuiApp } from "../../src/tui/app/app";
import type { Transcript } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import { tuiTheme } from "../../src/tui/theme";
import { createTerminalStub, createTuiAgentStub, createTuiAppOptions } from "./app-fixture";

describe("user task notification", () => {
  test("renders a queued task update when it starts the next run", () => {
    const app = new KanaTuiApp(
      () => createTuiAgentStub(),
      createTerminalStub(),
      createTuiAppOptions(),
    );
    const internal = app as unknown as {
      handleConversationEvent: (event: ConversationRuntimeEvent) => void;
      transcript: Transcript;
    };

    internal.handleConversationEvent({
      type: "run_start",
      source: "user_task",
      input: {
        ...createMessageIdentity({ kind: "user_task_completion", taskId: "task-1" }),
        role: "user",
        content:
          "[User task update]\nTask task-1 was done by the user.\nUser response:\nLabels are clear.",
      },
    });

    const rendered = internal.transcript.render(80);
    expect(rendered.map(stripAnsi)).toEqual([
      "Task task-1 was done by the user.",
      "User response:",
      "Labels are clear.",
    ]);
    expect(rendered[0]).toContain(`\x1b[38;2;${tuiTheme.muted.join(";")}m`);
  });
});
