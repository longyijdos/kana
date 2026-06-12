import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
        approvals("git status"),
        toolCall("read", { path: "package.json" }),
      ),
    ).toBe(true);
    expect(
      shouldRequestToolApproval(
        { mode: "always" },
        approvals("git status"),
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

  test("unless trusted mode skips read and persisted bash commands", () => {
    const trusted = approvals("git status");

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
      version: 1,
      bash: {
        commands: ["git status", "rg approval src"],
      },
    });
    expect(loadKanaToolApprovals(env).bash.commands).toEqual([
      "git status",
      "rg approval src",
    ]);
  });
});

function approvals(...commands: string[]): KanaToolApprovals {
  return {
    version: 1,
    bash: {
      commands,
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
