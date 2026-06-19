import { describe, expect, test } from "bun:test";
import { LocalShellController } from "../src/tui/app/local-shell-controller";
import { Editor, Transcript } from "../src/tui/components";
import { stripAnsi } from "../src/tui/render";
import { type Terminal, Tui } from "../src/tui/runtime";

class FakeTerminal implements Terminal {
  writes: string[] = [];
  input?: (data: string) => void;
  resize?: () => void;
  columns = 80;
  rows = 24;

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.input = onInput;
    this.resize = onResize;
  }

  stop(): void {}

  write(data: string): void {
    this.writes.push(data);
  }
}

describe("local shell controller", () => {
  test("runs user shell commands without requesting tool approval", async () => {
    const transcript = new Transcript();
    const controller = new LocalShellController({
      editor: new Editor(),
      transcript,
      tui: new Tui(new FakeTerminal()),
      setRunning() {},
      clearRunStatus() {},
      updateStatus() {},
    });

    await controller.submit("printf local-shell", "!printf local-shell");

    const lines = transcript.render(100).map(stripAnsi);

    expect(lines).toContain("Ran printf local-shell");
    expect(lines.join("\n")).toContain("stdout:\nlocal-shell");
    expect(lines).not.toContain("Allow agent to run bash?");
  });
});
