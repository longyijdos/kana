import { expect, test } from "bun:test";
import { Agent } from "../../src/agent";
import type { Message } from "../../src/core";
import { KanaTuiApp } from "../../src/tui/app/app";
import type { SlashCommand } from "../../src/tui/app/slash-command-controller";
import type { ContentViewer, Transcript } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Component } from "../../src/tui/runtime";
import { waitFor } from "../helpers/async-control";
import { ControlledModel } from "../helpers/controlled-model";
import { createTerminalStub, createTuiAppOptions } from "./app-fixture";

test("main transcript and BTW stream independently without persisting BTW", async () => {
  const model = new ControlledModel();
  const journalMessages: Message[] = [];
  const committedRuns: Message[][] = [];
  const agent = new Agent({
    model,
    journal: {
      startRun: ({ messages }) => {
        journalMessages.push(...messages);
      },
      appendMessage: ({ message }) => {
        journalMessages.push(message);
      },
      appendCompaction: () => {},
      endRun: () => {},
    },
    onRunCommitted: ({ messages }) => {
      committedRuns.push(messages);
    },
  });
  const app = new KanaTuiApp(() => agent, createTerminalStub(), createTuiAppOptions());
  const internal = app as unknown as {
    submitPrompt(prompt: string): Promise<void>;
    handleCommand(command: SlashCommand): void;
    transcript: Transcript;
    tui: { getFocus(): Component | undefined };
  };
  const mainRun = internal.submitPrompt("Main task");
  await waitFor(() => model.requests.length === 1);
  internal.handleCommand({
    type: "command",
    name: "btw",
    arguments: "Side question",
    raw: "/btw Side question",
  });
  await waitFor(() => model.requests.length === 2);
  const viewer = internal.tui.getFocus() as ContentViewer;
  expect(model.requests[1]!.context.messages.map((message) => message.role)).toEqual([
    "user",
    "user",
  ]);
  expect(model.requests[1]!.context.messages[0]).toMatchObject({ content: "Main task" });
  model.requests[0]!.update("Main answer");
  model.requests[1]!.update("Side answer");
  await waitFor(() => stripAnsi(internal.transcript.render(80).join("\n")).includes("Main answer"));
  await waitFor(() => stripAnsi(viewer.render(80).join("\n")).includes("Side answer"));
  expect(stripAnsi(internal.transcript.render(80).join("\n"))).not.toContain("Side answer");
  expect(agent.state.isRunning).toBe(true);
  expect(agent.inbox).toEqual({ nextStep: [], nextTurn: [] });
  model.requests[1]!.complete("Side answer");
  await waitFor(() => stripAnsi(viewer.render(80)[0] ?? "").includes("Done"));
  expect(committedRuns).toEqual([]);
  expect(journalMessages).toMatchObject([{ content: "Main task" }]);
  model.requests[0]!.complete("Main answer");
  await mainRun;
  expect(committedRuns).toHaveLength(1);
  expect(journalMessages).toEqual(agent.state.messages);
  expect(JSON.stringify(journalMessages)).not.toContain("Side question");
  expect(JSON.stringify(journalMessages)).not.toContain("Side answer");
  viewer.handleInput("\x1b");
  internal.handleCommand({ type: "command", name: "btw", arguments: "", raw: "/btw" });
  expect(internal.tui.getFocus()).toBe(viewer);
  internal.handleCommand({ type: "command", name: "new", arguments: "", raw: "/new" });
  await waitFor(() => internal.tui.getFocus() !== viewer);
  internal.handleCommand({ type: "command", name: "btw", arguments: "", raw: "/btw" });
  expect(stripAnsi(internal.transcript.render(80).join("\n"))).toContain(
    "no previous BTW question",
  );
  await app.stop();
});
