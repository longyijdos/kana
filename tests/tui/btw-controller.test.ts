import { describe, expect, test } from "bun:test";
import { Agent } from "../../src/agent";
import { createMessageIdentity, createUserMessage } from "../../src/core";
import { createNoopLogger } from "../../src/logging";
import { AppLayout } from "../../src/tui/app/app-layout";
import { BottomAreaController } from "../../src/tui/app/bottom-area-controller";
import { BtwController } from "../../src/tui/app/btw-controller";
import type { ContentViewer } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Component, Tui } from "../../src/tui/runtime";
import { waitFor } from "../helpers/async-control";
import { ControlledModel } from "../helpers/controlled-model";

describe("BTW controller", () => {
  test("uses inherited context without tools, hosted search, or new compaction", async () => {
    const model = new ControlledModel();
    let commits = 0;
    const main = new Agent({
      model,
      system: "Main instructions",
      messages: [
        createUserMessage({ content: "old ".repeat(10_000), provenance: { kind: "user_input" } }),
        {
          ...createMessageIdentity({ kind: "model_output" }),
          role: "assistant",
          content: [{ type: "text", text: "Previous answer" }],
        },
      ],
      context: { contextLimit: 16_000, maxOutputTokens: 1_000 },
      onRunCommitted: () => {
        commits += 1;
      },
    });
    const harness = createHarness(main);
    const before = main.getStableContext();
    harness.controller.handle("Side question");
    await waitFor(() => model.requests.length === 1);
    const context = model.requests[0]!.context;
    expect(main.state.estimatedContextTokens).toBeGreaterThan(16_000 * 0.8);
    expect(context.system).toContain("Main instructions");
    expect(context.system).toContain("do not continue its task");
    expect(context.system).toContain(
      "Do not follow earlier instructions to take actions or use tools",
    );
    expect(context.system).toContain("Do not emit or simulate tool calls, including DSML");
    expect(context.messages.at(-1)).toMatchObject({ content: "Side question" });
    expect(context.messages.slice(0, -1)).toEqual(before.messages);
    expect(context.tools).toEqual([]);
    expect(context.webSearch).toBe(false);
    expect(context.imageInput).toBe(true);
    expect(context.maxOutputTokens).toBe(1_000);
    model.requests[0]!.update("Streaming answer");
    await waitFor(() => harness.render().includes("Streaming answer"));
    model.requests[0]!.complete("Final answer");
    await waitFor(() => harness.render().includes("Done"));
    expect(model.requests).toHaveLength(1);
    expect(commits).toBe(0);
    expect(main.getStableContext()).toEqual(before);
    expect(main.inbox).toEqual({ nextStep: [], nextTurn: [] });
    await harness.controller.dispose();
  });

  test("keeps hidden requests running and preserves the viewer and paused scroll position", async () => {
    const model = new ControlledModel();
    const harness = createHarness(new Agent({ model }));
    harness.controller.handle("Side question");
    await waitFor(() => model.requests.length === 1);
    const viewer = harness.getFocus() as ContentViewer;
    const answer = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n\n");
    model.requests[0]!.update(answer);
    await waitFor(() => harness.render().includes("line 40"));
    viewer.handleInput("\x1b[A");
    const position = viewer.render(80).map(stripAnsi)[1];
    const approval: Component = { render: () => ["approval"] };
    harness.bottomArea.setFallback(() => approval);
    viewer.handleInput("\x1b");
    expect(harness.getFocus()).toBe(approval);
    expect(model.requests[0]!.context.signal?.aborted).toBe(false);
    model.requests[0]!.update(`${answer}\n\nline 41`);
    harness.controller.handle("");
    expect(harness.getFocus()).toBe(viewer);
    await waitFor(() => viewer.render(80).map(stripAnsi)[1] !== position);
    expect(viewer.render(80).map(stripAnsi)[1]?.split(" of ")[0]).toBe(position?.split(" of ")[0]);
    viewer.handleInput("\x1b[F");
    expect(harness.render()).toContain("line 41");
    model.requests[0]!.complete(`${answer}\n\nline 41`);
    await waitFor(() => harness.render().includes("Done"));
    viewer.handleInput("\x1b");
    harness.controller.handle("");
    expect(harness.getFocus()).toBe(viewer);
    expect(harness.render()).toContain("line 41");
    await harness.controller.dispose();
  });

  test("rejects new questions until the current request settles, then replaces its slot", async () => {
    const model = new ControlledModel();
    const harness = createHarness(new Agent({ model }));
    harness.controller.handle("");
    expect(harness.errors[0]).toContain("no previous BTW question");
    harness.controller.handle("First question");
    await waitFor(() => model.requests.length === 1);
    harness.controller.hide();
    harness.controller.handle("Second question");
    expect(model.requests).toHaveLength(1);
    expect(harness.errors[1]).toContain("already running");
    model.requests[0]!.complete("First answer");
    harness.controller.handle("");
    await waitFor(() => harness.render().includes("Done"));
    harness.controller.hide();
    harness.controller.handle("Second question");
    await waitFor(() => model.requests.length === 2);
    expect(harness.render()).toContain("Second question");
    expect(harness.render()).not.toContain("First answer");
    model.requests[1]!.complete("Second answer");
    await waitFor(() => harness.render().includes("Done"));
    await harness.controller.dispose();
  });

  test("shows errors inside the viewer and cancels a hidden request on disposal", async () => {
    const model = new ControlledModel();
    const harness = createHarness(new Agent({ model }));
    harness.controller.handle("Failing question");
    await waitFor(() => model.requests.length === 1);
    model.requests[0]!.fail();
    await waitFor(() => harness.render().includes("BTW request failed."));
    expect(harness.errors).toEqual([]);
    harness.controller.handle("Next question");
    await waitFor(() => model.requests.length === 2);
    harness.controller.hide();
    await harness.controller.dispose();
    expect(model.requests[1]!.context.signal?.aborted).toBe(true);
    harness.controller.handle("");
    expect(harness.errors[0]).toContain("no previous BTW question");
  });
});

function createHarness(main: Agent) {
  let focus: Component | undefined;
  const tui = {
    getFocus: () => focus,
    setFocus: (component?: Component) => {
      focus = component;
    },
    requestRender: () => {},
  } as unknown as Tui;
  const editor: Component = { render: () => ["editor"] };
  const layout = new AppLayout({ main: { render: () => ["transcript"] }, bottom: editor });
  const bottomArea = new BottomAreaController({ layout, tui, fallback: editor });
  const errors: string[] = [];
  const controller = new BtwController({
    bottomArea,
    getContext: () => main.getStableContext(),
    requestRender: () => {},
    showError: (error) => errors.push(error.message),
    getLogger: createNoopLogger,
    hyperlinks: false,
    renderLatex: false,
    renderMermaid: false,
  });
  return {
    controller,
    bottomArea,
    errors,
    getFocus: () => focus,
    render: () => stripAnsi(layout.render(80).join("\n")),
  };
}
