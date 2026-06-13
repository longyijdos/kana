import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_KANA_TOOL_APPROVALS,
  addTrustedBashCommand,
  getKanaConfigPaths,
  loadKanaToolApprovals,
  shouldRequestToolApproval,
  type KanaToolApprovals,
} from "@/kana";
import type { ToolCallContent } from "@/core";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Kana tool approval", () => {
  test("always mode requests approval for trusted tools", () => {
    expect(
      shouldRequestToolApproval(
        { mode: "always" },
        approvals({ exactCommands: ["git status"] }),
        toolCall("read", { path: "package.json" }),
      ),
    ).toBe(true);
    expect(
      shouldRequestToolApproval(
        { mode: "always" },
        approvals({ exactCommands: ["git status"] }),
        toolCall("bash", { command: "git status" }),
      ),
    ).toBe(true);
  });

  test("never mode skips approval for all tools", () => {
    expect(
      shouldRequestToolApproval(
        { mode: "never" },
        approvals(),
        toolCall("edit", { path: "file.ts" }),
      ),
    ).toBe(false);
  });

  test("unless trusted mode skips read and exact bash commands", () => {
    const trusted = approvals({ exactCommands: ["git status"] });

    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("read", { path: "package.json" }),
      ),
    ).toBe(false);
    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("bash", { command: " git status " }),
      ),
    ).toBe(false);
    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("bash", { command: "git status --short" }),
      ),
    ).toBe(true);
    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("write", { path: "notes.txt", content: "hello" }),
      ),
    ).toBe(true);
  });

  test("unless trusted mode skips simple configured read-only bash commands", () => {
    const trusted = approvals({ readOnlyCommands: ["ls", "grep", "rg"] });

    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("bash", { command: "ls -la src" }),
      ),
    ).toBe(false);
    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("bash", { command: 'rg -n "approval mode" src' }),
      ),
    ).toBe(false);
    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("bash", { command: "grep -R 'approval' src" }),
      ),
    ).toBe(false);
  });

  test("unless trusted mode requests approval for composed read-only bash commands", () => {
    const trusted = approvals({ readOnlyCommands: ["rg"] });

    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("bash", { command: "rg approval src > matches.txt" }),
      ),
    ).toBe(true);
    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("bash", { command: "rg approval src; rm notes.txt" }),
      ),
    ).toBe(true);
    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("bash", { command: "rg $(rm notes.txt) src" }),
      ),
    ).toBe(true);
    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("bash", { command: "./rg approval src" }),
      ),
    ).toBe(true);
  });

  test("loads default approvals when the approvals file is missing", () => {
    const env = createTempEnv();

    expect(loadKanaToolApprovals(env)).toEqual(DEFAULT_KANA_TOOL_APPROVALS);
    expect(existsSync(getKanaConfigPaths(env).approvalsPath)).toBe(false);
  });

  test("persists trusted bash commands under the Kana home directory", () => {
    const env = createTempEnv();

    addTrustedBashCommand(" git status ", env);
    addTrustedBashCommand("git status", env);
    addTrustedBashCommand("rg approval src", env);

    const approvalsPath = getKanaConfigPaths(env).approvalsPath;

    expect(JSON.parse(readFileSync(approvalsPath, "utf8"))).toEqual({
      version: 2,
      bash: {
        exactCommands: ["git status", "rg approval src"],
        readOnlyCommands: DEFAULT_KANA_TOOL_APPROVALS.bash.readOnlyCommands,
      },
    });
    expect(loadKanaToolApprovals(env).bash.exactCommands).toEqual([
      "git status",
      "rg approval src",
    ]);
  });

  test("preserves manually configured read-only bash commands when adding exact commands", () => {
    const env = createTempEnv();

    saveApprovals(
      {
        version: 2,
        bash: {
          exactCommands: [],
          readOnlyCommands: ["ls", "rg"],
        },
      },
      env,
    );
    addTrustedBashCommand("git status", env);

    expect(loadKanaToolApprovals(env)).toEqual({
      version: 2,
      bash: {
        exactCommands: ["git status"],
        readOnlyCommands: ["ls", "rg"],
      },
    });
  });

  test("rejects read-only bash command entries with arguments or paths", () => {
    const env = createTempEnv();

    saveApprovals(
      {
        version: 2,
        bash: {
          exactCommands: [],
          readOnlyCommands: ["rg src"],
        },
      },
      env,
    );

    expect(() => loadKanaToolApprovals(env)).toThrow(
      "approvals.bash.readOnlyCommands entries must be executable names.",
    );

    saveApprovals(
      {
        version: 2,
        bash: {
          exactCommands: [],
          readOnlyCommands: ["./rg"],
        },
      },
      env,
    );

    expect(() => loadKanaToolApprovals(env)).toThrow(
      "approvals.bash.readOnlyCommands entries must be executable names.",
    );
  });
});

function approvals(
  bash: Partial<KanaToolApprovals["bash"]> = {},
): KanaToolApprovals {
  return {
    version: 2,
    bash: {
      exactCommands: bash.exactCommands ?? [],
      readOnlyCommands: bash.readOnlyCommands ?? [],
    },
  };
}

function toolCall(name: string, args: unknown): ToolCallContent {
  return {
    type: "tool_call",
    id: `call_${name}`,
    name,
    args,
  };
}

function createTempEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), "kana-tool-approval-"));
  tempDirs.push(home);

  return {
    HOME: home,
    KANA_HOME: path.join(home, ".kana"),
  };
}

function saveApprovals(
  approvals: KanaToolApprovals,
  env: NodeJS.ProcessEnv,
): void {
  const approvalsPath = getKanaConfigPaths(env).approvalsPath;
  const approvalsDir = path.dirname(approvalsPath);

  mkdirSync(approvalsDir, { recursive: true });
  writeFileSync(approvalsPath, `${JSON.stringify(approvals, null, 2)}\n`);
}
