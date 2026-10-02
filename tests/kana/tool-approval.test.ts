import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolCallContent } from "@/core";
import {
  addTrustedShellCommand,
  createKanaToolApprovalStore,
  DEFAULT_KANA_TOOL_APPROVALS,
  getKanaConfigPaths,
  getShellCommand,
  type KanaToolApprovals,
  loadKanaToolApprovals,
  shouldRequestToolApproval,
} from "@/kana";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Kana tool approval", () => {
  test("run_code itself does not request approval", () => {
    for (const mode of ["always", "unless_trusted", "never"] as const) {
      expect(
        shouldRequestToolApproval(
          { mode },
          approvals(),
          toolCall("run_code", { code: "return 1" }),
        ),
      ).toBe(false);
    }
  });

  test("always requests a user task decision, including in never mode", () => {
    for (const mode of ["always", "unless_trusted", "never"] as const) {
      expect(
        shouldRequestToolApproval(
          { mode },
          approvals(),
          toolCall("delegate_user_task", { task: "Check the screenshot." }),
        ),
      ).toBe(true);
    }
  });

  test("MCP catalogs are readable while calls follow the approval policy", () => {
    for (const mode of ["always", "unless_trusted", "never"] as const) {
      expect(
        shouldRequestToolApproval(
          { mode },
          approvals(),
          toolCall("mcp_list_tools", { name: "github" }),
        ),
      ).toBe(false);
      expect(
        shouldRequestToolApproval(
          { mode },
          approvals(),
          toolCall("mcp_describe_tool", { server: "github", tool: "read" }),
        ),
      ).toBe(false);
      expect(
        shouldRequestToolApproval(
          { mode },
          approvals(),
          toolCall("mcp_call", {
            server: "github",
            tool: "read",
            arguments: {},
          }),
        ),
      ).toBe(mode !== "never");
    }
  });

  test("job_start does not inherit Shell command trust", () => {
    const rules = approvals({ exactCommands: ["bun run dev"], readOnlyCommands: ["pwd"] });
    for (const mode of ["always", "never", "unless_trusted"] as const) {
      for (const command of ["bun run dev", "pwd", "touch output.txt"]) {
        const call = toolCall("job_start", { command });
        expect(shouldRequestToolApproval({ mode }, rules, call)).toBe(mode !== "never");
        expect(getShellCommand(call)).toBeUndefined();
      }
    }
  });

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
        toolCall("remember", { content: "Use Chinese by default." }),
      ),
    ).toBe(false);
    for (const name of ["spawn_subagent", "wait_subagent", "cancel_subagent"]) {
      expect(
        shouldRequestToolApproval(
          { mode: "always" },
          approvals({ exactCommands: ["git status"] }),
          toolCall(name, {}),
        ),
      ).toBe(false);
    }
    expect(
      shouldRequestToolApproval(
        { mode: "always" },
        approvals({ exactCommands: ["git status"] }),
        toolCall("schedule_wake", { afterMinutes: 30, message: "Check the task." }),
      ),
    ).toBe(false);
    expect(
      shouldRequestToolApproval(
        { mode: "always" },
        approvals({ exactCommands: ["git status"] }),
        toolCall("todo_write", {
          items: [{ content: "Check the task", status: "pending" }],
        }),
      ),
    ).toBe(false);
    expect(
      shouldRequestToolApproval(
        { mode: "always" },
        approvals({ exactCommands: ["git status"] }),
        toolCall("update_goal", { status: "completed" }),
      ),
    ).toBe(false);
    expect(
      shouldRequestToolApproval(
        { mode: "always" },
        approvals({ exactCommands: ["git status"] }),
        toolCall("shell", { command: "git status" }),
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

  test("unless trusted mode skips read-only tools and exact shell commands", () => {
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
        toolCall("list", { path: "." }),
      ),
    ).toBe(false);
    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("glob", { pattern: "**/*.ts" }),
      ),
    ).toBe(false);
    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("grep", { pattern: "approval", path: "src" }),
      ),
    ).toBe(false);
    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("view_image", { path: "screenshot.png" }),
      ),
    ).toBe(false);
    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("shell", { command: " git status " }),
      ),
    ).toBe(false);
    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("shell", { command: "git status --short" }),
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

  test("unless trusted mode skips simple configured read-only shell commands", () => {
    const trusted = approvals({ readOnlyCommands: ["ls", "grep", "rg"] });

    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("shell", { command: "ls -la src" }),
      ),
    ).toBe(false);
    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("shell", { command: 'rg -n "approval mode" src' }),
      ),
    ).toBe(false);
    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("shell", { command: "grep -R 'approval' src" }),
      ),
    ).toBe(false);
  });

  test("unless trusted mode requests approval for composed read-only shell commands", () => {
    const trusted = approvals({ readOnlyCommands: ["rg"] });

    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("shell", { command: "rg approval src > matches.txt" }),
      ),
    ).toBe(true);
    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("shell", { command: "rg approval src; rm notes.txt" }),
      ),
    ).toBe(true);
    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("shell", { command: "rg $(rm notes.txt) src" }),
      ),
    ).toBe(true);
    expect(
      shouldRequestToolApproval(
        { mode: "unless_trusted" },
        trusted,
        toolCall("shell", { command: "./rg approval src" }),
      ),
    ).toBe(true);
  });

  test("loads default approvals when the approvals file is missing", () => {
    const env = createTempEnv();

    expect(loadKanaToolApprovals(env)).toEqual(DEFAULT_KANA_TOOL_APPROVALS);
    expect(existsSync(getKanaConfigPaths(env).approvalsPath)).toBe(false);
  });

  test("rejects version 2 approval files without rewriting them", () => {
    const env = createTempEnv();
    const approvalsPath = getKanaConfigPaths(env).approvalsPath;
    const legacyContent = JSON.stringify({
      version: 2,
      bash: { exactCommands: ["git status"], readOnlyCommands: ["ls"] },
    });
    mkdirSync(path.dirname(approvalsPath), { recursive: true });
    writeFileSync(approvalsPath, legacyContent);

    expect(() => loadKanaToolApprovals(env)).toThrow("approvals.version must be 3.");
    expect(() => addTrustedShellCommand("git diff", env)).toThrow("approvals.version must be 3.");
    expect(readFileSync(approvalsPath, "utf8")).toBe(legacyContent);
  });

  test("persists trusted shell commands under the Kana home directory", () => {
    const env = createTempEnv();

    addTrustedShellCommand(" git status ", env);
    addTrustedShellCommand("git status", env);
    addTrustedShellCommand("rg approval src", env);

    const approvalsPath = getKanaConfigPaths(env).approvalsPath;

    expect(JSON.parse(readFileSync(approvalsPath, "utf8"))).toEqual({
      version: 3,
      shell: {
        exactCommands: ["git status", "rg approval src"],
        readOnlyCommands: DEFAULT_KANA_TOOL_APPROVALS.shell.readOnlyCommands,
      },
    });
    expect(loadKanaToolApprovals(env).shell.exactCommands).toEqual([
      "git status",
      "rg approval src",
    ]);
  });

  test("preserves manually configured read-only shell commands when adding exact commands", () => {
    const env = createTempEnv();

    saveApprovals(
      {
        version: 3,
        shell: {
          exactCommands: ["external command"],
          readOnlyCommands: ["ls", "rg"],
        },
      },
      env,
    );
    addTrustedShellCommand("git status", env);

    expect(loadKanaToolApprovals(env)).toEqual({
      version: 3,
      shell: {
        exactCommands: ["external command", "git status"],
        readOnlyCommands: ["ls", "rg"],
      },
    });
  });

  test("keeps a startup snapshot while merging trusted commands into the latest file", () => {
    const env = createTempEnv();
    saveApprovals(
      {
        version: 3,
        shell: {
          exactCommands: ["startup command"],
          readOnlyCommands: ["ls"],
        },
      },
      env,
    );
    const store = createKanaToolApprovalStore(env);

    saveApprovals(
      {
        version: 3,
        shell: {
          exactCommands: ["external command"],
          readOnlyCommands: ["rg"],
        },
      },
      env,
    );

    expect(store.addTrustedShellCommand("local command")).toEqual({
      version: 3,
      shell: {
        exactCommands: ["startup command", "local command"],
        readOnlyCommands: ["ls"],
      },
    });
    expect(loadKanaToolApprovals(env)).toEqual({
      version: 3,
      shell: {
        exactCommands: ["external command", "local command"],
        readOnlyCommands: ["rg"],
      },
    });
  });

  test("rejects read-only shell command entries with arguments or paths", () => {
    const env = createTempEnv();

    saveApprovals(
      {
        version: 3,
        shell: {
          exactCommands: [],
          readOnlyCommands: ["rg src"],
        },
      },
      env,
    );

    expect(() => loadKanaToolApprovals(env)).toThrow(
      "approvals.shell.readOnlyCommands entries must be executable names.",
    );

    saveApprovals(
      {
        version: 3,
        shell: {
          exactCommands: [],
          readOnlyCommands: ["./rg"],
        },
      },
      env,
    );

    expect(() => loadKanaToolApprovals(env)).toThrow(
      "approvals.shell.readOnlyCommands entries must be executable names.",
    );
  });
});

function approvals(shell: Partial<KanaToolApprovals["shell"]> = {}): KanaToolApprovals {
  return {
    version: 3,
    shell: {
      exactCommands: shell.exactCommands ?? [],
      readOnlyCommands: shell.readOnlyCommands ?? [],
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

function saveApprovals(approvals: KanaToolApprovals, env: NodeJS.ProcessEnv): void {
  const approvalsPath = getKanaConfigPaths(env).approvalsPath;
  const approvalsDir = path.dirname(approvalsPath);

  mkdirSync(approvalsDir, { recursive: true });
  writeFileSync(approvalsPath, `${JSON.stringify(approvals, null, 2)}\n`);
}
