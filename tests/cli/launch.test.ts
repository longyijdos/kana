import { describe, expect, test } from "bun:test";
import { createCli } from "../../src/cli";
import type { StartHeadlessOptions } from "../../src/headless";
import type { StartTuiOptions } from "../../src/tui";
import { KANA_VERSION } from "../../src/version";
import { defaultCliOptions, parseCli } from "./cli-fixture";

describe("CLI launch", () => {
  test("uses the shared application version", () => {
    expect(createCli(defaultCliOptions()).version()).toBe(KANA_VERSION);
  });

  test("starts the TUI without an initial prompt by default", async () => {
    const calls: Array<StartTuiOptions | undefined> = [];

    await parseCli(["node", "kana"], {
      startTui: (options) => {
        calls.push(options);
      },
    });

    expect(calls).toEqual([undefined]);
  });

  test("passes root arguments as an initial TUI prompt", async () => {
    const calls: Array<StartTuiOptions | undefined> = [];

    await parseCli(["node", "kana", "explain", "this", "repo"], {
      startTui: (options) => {
        calls.push(options);
      },
    });

    expect(calls).toEqual([{ initialPrompt: "explain this repo" }]);
  });

  test("forwards clean mode to new and resumed TUI entry requests", async () => {
    const calls: Array<StartTuiOptions | undefined> = [];
    const options = {
      startTui: (startOptions?: StartTuiOptions) => {
        calls.push(startOptions);
      },
    };

    await parseCli(["node", "kana", "--clean"], options);
    await parseCli(["node", "kana", "resume", "session-1", "--clean"], options);

    expect(calls).toEqual([
      { launchMode: "clean" },
      {
        resumeSessionId: "session-1",
        showResumePicker: false,
        launchMode: "clean",
      },
    ]);
  });

  test("keeps resume as a subcommand", async () => {
    const calls: Array<StartTuiOptions | undefined> = [];

    await parseCli(["node", "kana", "resume", "session-1"], {
      startTui: (options) => {
        calls.push(options);
      },
    });

    expect(calls).toEqual([
      {
        resumeSessionId: "session-1",
        showResumePicker: false,
      },
    ]);
  });

  test("runs one headless turn with explicit machine-output and approval options", async () => {
    const calls: StartHeadlessOptions[] = [];

    await parseCli(
      ["node", "kana", "exec", "--json", "--allow-all-tools", "explain", "this", "repo"],
      {
        startHeadless: async (options) => {
          calls.push(options ?? {});
          return 0;
        },
      },
    );

    expect(calls).toEqual([
      {
        prompt: "explain this repo",
        json: true,
        allowAllTools: true,
      },
    ]);
  });

  test("forwards bounded Goal mode for new and resumed headless requests", async () => {
    const calls: StartHeadlessOptions[] = [];
    const options = {
      startHeadless: async (startOptions?: StartHeadlessOptions) => {
        calls.push(startOptions ?? {});
        return 0;
      },
    };

    await parseCli(["node", "kana", "exec", "--goal", "finish", "the", "task"], options);
    await parseCli(
      ["node", "kana", "exec", "resume", "session-1", "--goal", "finish", "it"],
      options,
    );

    expect(calls).toEqual([
      {
        prompt: "finish the task",
        goal: true,
        json: undefined,
        allowAllTools: undefined,
      },
      {
        prompt: "finish it",
        resumeSessionId: "session-1",
        goal: true,
        json: undefined,
        allowAllTools: undefined,
      },
    ]);
  });

  test("forwards clean mode to new and resumed headless entry requests", async () => {
    const calls: StartHeadlessOptions[] = [];
    const options = {
      startHeadless: async (startOptions?: StartHeadlessOptions) => {
        calls.push(startOptions ?? {});
        return 0;
      },
    };

    await parseCli(["node", "kana", "exec", "--clean", "inspect"], options);
    await parseCli(["node", "kana", "exec", "resume", "session-1", "--clean", "continue"], options);

    expect(calls).toEqual([
      {
        prompt: "inspect",
        json: undefined,
        allowAllTools: undefined,
        launchMode: "clean",
      },
      {
        prompt: "continue",
        resumeSessionId: "session-1",
        json: undefined,
        allowAllTools: undefined,
        launchMode: "clean",
      },
    ]);
  });

  test("parses and forwards Agent-run timeouts for new and resumed headless requests", async () => {
    const calls: StartHeadlessOptions[] = [];
    const options = {
      startHeadless: async (startOptions?: StartHeadlessOptions) => {
        calls.push(startOptions ?? {});
        return 0;
      },
    };

    await parseCli(["node", "kana", "exec", "--timeout", "30m", "inspect"], options);
    await parseCli(
      ["node", "kana", "exec", "resume", "session-1", "--timeout", "2h", "continue"],
      options,
    );

    expect(calls).toEqual([
      {
        prompt: "inspect",
        json: undefined,
        allowAllTools: undefined,
        timeoutMs: 1_800_000,
      },
      {
        prompt: "continue",
        resumeSessionId: "session-1",
        json: undefined,
        allowAllTools: undefined,
        timeoutMs: 7_200_000,
      },
    ]);
  });

  test("resumes a session in headless mode and leaves a missing prompt for stdin", async () => {
    const calls: StartHeadlessOptions[] = [];

    await parseCli(["node", "kana", "exec", "resume", "session-1", "--json"], {
      startHeadless: async (options) => {
        calls.push(options ?? {});
        return 0;
      },
    });

    expect(calls).toEqual([
      {
        prompt: undefined,
        resumeSessionId: "session-1",
        json: true,
        allowAllTools: undefined,
      },
    ]);
  });

  test("waits for asynchronous TUI shutdown", async () => {
    const events: string[] = [];
    let release!: () => void;
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parsingFinished = false;
    const parsing = parseCli(["node", "kana"], {
      startTui: async () => {
        events.push("started");
        await stopped;
        events.push("stopped");
      },
    }).then(() => {
      parsingFinished = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["started"]);
    expect(parsingFinished).toBe(false);

    release();
    await parsing;

    expect(events).toEqual(["started", "stopped"]);
    expect(parsingFinished).toBe(true);
  });
});
