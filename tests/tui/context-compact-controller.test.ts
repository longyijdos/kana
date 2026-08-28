import { describe, expect, test } from "bun:test";
import { ContextCompactController } from "../../src/tui/app/context-compact-controller";
import { Transcript } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Tui } from "../../src/tui/runtime";

describe("context compact controller", () => {
  test("owns the temporary compaction block until the operation settles", async () => {
    const pending = deferred();
    const transcript = new Transcript();
    let renderCount = 0;
    const controller = new ContextCompactController({
      transcript,
      tui: {
        requestRender: () => {
          renderCount += 1;
        },
      } as unknown as Tui,
      canCompact: () => true,
      compact: () => pending.promise,
    });

    const operation = controller.compact();

    expect(renderTranscript(transcript)).toBe("Compacting context…");
    expect(renderCount).toBe(1);

    controller.handleCompacted();
    expect(renderTranscript(transcript)).toBe("");

    pending.resolve();
    await operation;

    expect(renderTranscript(transcript)).toBe("");
    expect(renderCount).toBe(2);
  });

  test("removes the temporary block when compaction fails", async () => {
    const transcript = new Transcript();
    const controller = new ContextCompactController({
      transcript,
      tui: { requestRender() {} } as unknown as Tui,
      canCompact: () => true,
      compact: async () => {
        throw new Error("compaction failed");
      },
    });

    await expect(controller.compact()).resolves.toBeUndefined();

    expect(renderTranscript(transcript)).toBe("");
  });
});

function renderTranscript(transcript: Transcript): string {
  return stripAnsi(transcript.render(80).join("\n"));
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}
