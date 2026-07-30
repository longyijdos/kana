import { describe, expect, test } from "bun:test";
import type { AssistantContent, AssistantMessage } from "../src/core";
import { StreamingTextPresenter } from "../src/tui/app/streaming-text-presenter";

type PublishedMessage = {
  message: AssistantMessage;
  complete: boolean;
};

class ManualScheduler {
  readonly delays: number[] = [];
  private readonly callbacks = new Map<ReturnType<typeof setTimeout>, () => void>();
  private nextTimer = 0;

  readonly schedule = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    this.nextTimer += 1;
    const timer = this.nextTimer as unknown as ReturnType<typeof setTimeout>;
    this.callbacks.set(timer, callback);
    this.delays.push(delayMs);
    return timer;
  };

  readonly cancel = (timer: ReturnType<typeof setTimeout>): void => {
    this.callbacks.delete(timer);
  };

  get size(): number {
    return this.callbacks.size;
  }

  runNext(): void {
    const next = this.callbacks.entries().next().value;
    if (!next) {
      throw new Error("Expected a scheduled streaming-text frame.");
    }
    const [timer, callback] = next;
    this.callbacks.delete(timer);
    callback();
  }

  runAll(): void {
    let frames = 0;
    while (this.callbacks.size > 0) {
      frames += 1;
      if (frames > 1_000) {
        throw new Error("Streaming-text presenter did not settle.");
      }
      this.runNext();
    }
  }
}

function createHarness(): {
  presenter: StreamingTextPresenter;
  scheduler: ManualScheduler;
  published: PublishedMessage[];
  settledCount: () => number;
} {
  const scheduler = new ManualScheduler();
  const published: PublishedMessage[] = [];
  let settled = 0;
  const presenter = new StreamingTextPresenter({
    onUpdate: (message, complete) => published.push({ message, complete }),
    onSettled: () => {
      settled += 1;
    },
    requestRender: () => {},
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });

  return {
    presenter,
    scheduler,
    published,
    settledCount: () => settled,
  };
}

function assistantMessage(
  text: string,
  trailingContent: AssistantContent[] = [],
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }, ...trailingContent],
  };
}

function visibleText(update: PublishedMessage): string {
  const content = update.message.content[0];
  return content?.type === "text" ? content.text : "";
}

describe("tui streaming text presenter", () => {
  test("reveals sparse text deltas immediately", () => {
    const { presenter, scheduler, published } = createHarness();

    presenter.start(assistantMessage(""));
    presenter.update(assistantMessage("你"), true);

    expect(published.map(visibleText)).toEqual(["", "你"]);
    expect(scheduler.size).toBe(1);

    scheduler.runNext();
    presenter.update(assistantMessage("你好"), true);

    expect(published.map(visibleText)).toEqual(["", "你", "你好"]);
    expect(scheduler.delays).toEqual([16, 16]);
    presenter.flush();
  });

  test("reveals a completed burst at a bounded adaptive rate", () => {
    const { presenter, scheduler, published, settledCount } = createHarness();
    const finalText = "流".repeat(40);

    presenter.start(assistantMessage(""));
    for (let length = 1; length <= 40; length += 1) {
      presenter.update(assistantMessage("流".repeat(length)), true);
    }
    presenter.finish(assistantMessage(finalText));
    scheduler.runAll();

    const lengths = published.map((update) => [...visibleText(update)].length);
    const increments = lengths.slice(1).map((length, index) => length - (lengths[index] ?? 0));

    expect(lengths.at(-1)).toBe(40);
    expect(new Set(increments)).toEqual(new Set([1, 2, 3, 4]));
    expect(increments.every((increment) => increment >= 1 && increment <= 4)).toBe(true);
    expect(scheduler.delays.every((delay) => delay === 16)).toBe(true);
    expect(published.slice(0, -1).every((update) => !update.complete)).toBe(true);
    expect(published.at(-1)?.complete).toBe(true);
    expect(settledCount()).toBe(1);
  });

  test("paces only text while publishing non-text state immediately", () => {
    const { presenter, published } = createHarness();
    const thinking = { type: "thinking" as const, text: "summary" };
    const toolCall = {
      type: "tool_call" as const,
      id: "call_1",
      name: "read",
      args: { path: "AGENTS.md" },
    };

    presenter.start(assistantMessage(""));
    presenter.update(assistantMessage("abcdef"), true);
    presenter.update(assistantMessage("abcdef", [thinking, toolCall]), false);

    const latest = published.at(-1)?.message;
    expect(latest?.content).toEqual([{ type: "text", text: "a" }, thinking, toolCall]);
    presenter.flush();
  });

  test("never reveals a partial grapheme", () => {
    const { presenter, scheduler, published } = createHarness();
    const family = "👨‍👩‍👧‍👦";
    const combined = "e\u0301";
    const finalText = `A${family}${combined}`;

    presenter.start(assistantMessage(""));
    presenter.update(assistantMessage(finalText), true);
    scheduler.runAll();

    expect(published.map(visibleText)).toEqual(["", "A", `A${family}`, finalText]);
    presenter.flush();
  });

  test("flushes pending text and cancels scheduled frames", () => {
    const { presenter, scheduler, published, settledCount } = createHarness();
    const finalText = "pending text that should flush";

    presenter.start(assistantMessage(""));
    presenter.update(assistantMessage(finalText), true);
    expect(scheduler.size).toBe(1);

    presenter.flush();

    expect(visibleText(published.at(-1) as PublishedMessage)).toBe(finalText);
    expect(published.at(-1)?.complete).toBe(true);
    expect(scheduler.size).toBe(0);
    expect(settledCount()).toBe(1);
  });
});
