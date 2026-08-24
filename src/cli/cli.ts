import { createInterface } from "node:readline/promises";
import { Command, InvalidArgumentError } from "commander";
import { parseHeadlessTimeout, type StartHeadlessOptions } from "@/headless";
import type {
  InstallKanaConfigResult,
  InstallKanaSkillsResult,
  KanaUpdateProgressEvent,
  KanaUpdateResult,
  ReinstallKanaSkillsResult,
  ResetKanaConfigResult,
  SyncKanaSkillsResult,
  UpdateKanaOptions,
} from "@/kana";
import {
  authorizeKanaOpenAICodex,
  getKanaOpenAICodexAuthStatus,
  loadKanaEnvironment,
  signOutKanaOpenAICodex,
  updateKana as updateKanaBinary,
} from "@/kana";
import type { OAuthSessionStatus } from "@/oauth";
import type { StartTuiOptions } from "@/tui";
import { KANA_VERSION } from "@/version";

export type CreateCliOptions = {
  installKanaConfig: (env: NodeJS.ProcessEnv) => InstallKanaConfigResult;
  resetKanaConfig: (env: NodeJS.ProcessEnv) => ResetKanaConfigResult;
  installKanaSkills: (env: NodeJS.ProcessEnv) => Promise<InstallKanaSkillsResult>;
  reinstallKanaSkills: (env: NodeJS.ProcessEnv) => Promise<ReinstallKanaSkillsResult>;
  syncKanaSkills: (
    env: NodeJS.ProcessEnv,
    options: { targetAgent?: string; targetDir?: string },
  ) => SyncKanaSkillsResult;
  resyncKanaSkills: (
    env: NodeJS.ProcessEnv,
    options: { targetAgent?: string; targetDir?: string },
  ) => SyncKanaSkillsResult;
  authorizeOpenAICodex?: typeof authorizeKanaOpenAICodex;
  confirm?: (message: string) => Promise<boolean>;
  getOpenAICodexAuthStatus?: typeof getKanaOpenAICodexAuthStatus;
  isInteractive?: () => boolean;
  signOutOpenAICodex?: typeof signOutKanaOpenAICodex;
  log?: (message: string) => void;
  startHeadless: (options?: StartHeadlessOptions) => Promise<number>;
  startTui: (options?: StartTuiOptions) => Promise<void> | void;
  updateKana?: (options?: UpdateKanaOptions) => Promise<KanaUpdateResult>;
};

export function createCli(options: CreateCliOptions): Command {
  const installConfig = options.installKanaConfig;
  const installSkills = options.installKanaSkills;
  const reinstallSkills = options.reinstallKanaSkills;
  const resetConfig = options.resetKanaConfig;
  const log = options.log ?? console.log;
  const runHeadless = options.startHeadless;
  const runTui = options.startTui;
  const resyncSkills = options.resyncKanaSkills;
  const syncSkills = options.syncKanaSkills;
  const confirm = options.confirm ?? confirmInTerminal;
  const isInteractive = options.isInteractive ?? isInteractiveTerminal;
  const authorizeCodex = options.authorizeOpenAICodex ?? authorizeKanaOpenAICodex;
  const getCodexAuthStatus = options.getOpenAICodexAuthStatus ?? getKanaOpenAICodexAuthStatus;
  const signOutCodex = options.signOutOpenAICodex ?? signOutKanaOpenAICodex;
  const runUpdate = options.updateKana ?? updateKanaBinary;
  const program = new Command();

  program
    .name("kana")
    .description("Personal TypeScript/Bun agent runtime")
    .version(KANA_VERSION)
    .option("--clean", "Start a temporary session without custom context or session persistence")
    .argument("[prompt...]", "Prompt to send after opening the TUI")
    .action(async (promptParts: string[] = [], actionOptions: LaunchCommandOptions) => {
      const prompt = promptParts.join(" ").trim();
      const launchMode = getLaunchMode(actionOptions);

      if (prompt || launchMode) {
        await runTui({
          ...(prompt ? { initialPrompt: prompt } : {}),
          ...(launchMode ? { launchMode } : {}),
        });
        return;
      }

      await runTui();
    });

  program
    .command("resume")
    .description("Resume a saved agent session")
    .argument("[sessionId]", "Session id to resume")
    .action(
      async (
        sessionId: string | undefined,
        _actionOptions: LaunchCommandOptions,
        command: Command,
      ) => {
        const launchMode = getLaunchMode(command.optsWithGlobals<LaunchCommandOptions>());
        await runTui({
          resumeSessionId: sessionId,
          showResumePicker: sessionId === undefined,
          ...(launchMode ? { launchMode } : {}),
        });
      },
    );

  const execCommand = addHeadlessOptions(
    program
      .command("exec")
      .description("Run one complete agent turn without the TUI")
      .argument("[prompt...]", "Prompt to run; reads stdin when omitted"),
  );
  execCommand.action(
    async (promptParts: string[] = [], actionOptions: HeadlessCommandOptions, command: Command) => {
      const commandOptions = getHeadlessCommandOptions(actionOptions, command);
      const launchMode = getLaunchMode(commandOptions);
      await applyHeadlessExitCode(
        runHeadless({
          prompt: joinPromptParts(promptParts),
          json: commandOptions.json,
          allowAllTools: commandOptions.allowAllTools,
          ...(commandOptions.timeout === undefined ? {} : { timeoutMs: commandOptions.timeout }),
          ...(launchMode ? { launchMode } : {}),
        }),
      );
    },
  );

  addHeadlessOptions(
    execCommand
      .command("resume")
      .description("Resume a saved session for one complete agent turn")
      .argument("<sessionId>", "Session id to resume")
      .argument("[prompt...]", "Prompt to run; reads stdin when omitted"),
  ).action(
    async (
      sessionId: string,
      promptParts: string[] = [],
      actionOptions: HeadlessCommandOptions,
      command: Command,
    ) => {
      const commandOptions = getHeadlessCommandOptions(actionOptions, command);
      const launchMode = getLaunchMode(commandOptions);
      await applyHeadlessExitCode(
        runHeadless({
          prompt: joinPromptParts(promptParts),
          resumeSessionId: sessionId,
          json: commandOptions.json,
          allowAllTools: commandOptions.allowAllTools,
          ...(commandOptions.timeout === undefined ? {} : { timeoutMs: commandOptions.timeout }),
          ...(launchMode ? { launchMode } : {}),
        }),
      );
    },
  );

  program
    .command("install")
    .description("Create Kana support files under ~/.kana")
    .action(() => {
      const result = installConfig(process.env);
      if (result.configStatus !== "defaults") {
        log(formatInstallMessage("config", result.configPath, result.configStatus));
      }
      log(
        formatInstallMessage(
          "config example",
          result.configExamplePath,
          result.configExampleStatus,
        ),
      );
      log(formatInstallMessage("MCP config", result.mcpConfigPath, result.mcpConfigStatus));
      log(
        formatInstallMessage(
          "MCP activation state",
          result.mcpEnabledPath,
          result.mcpEnabledStatus,
        ),
      );
      log(formatInstallMessage("approvals", result.approvalsPath, result.approvalsStatus));
      log(
        formatInstallMessage("skills config", result.skillsConfigPath, result.skillsConfigStatus),
      );
      log(
        formatInstallMessage(
          "Custom provider example",
          result.customProviderExamplePath,
          result.customProviderExampleStatus,
        ),
      );
    });

  program
    .command("reset")
    .description("Reset Kana configuration while preserving credentials and user data")
    .option("--yes", "Reset without interactive confirmation")
    .action(async (commandOptions: { yes?: boolean }) => {
      const shouldReset = await confirmDestructiveAction({
        confirmed: commandOptions.yes,
        confirm,
        interactive: isInteractive,
        nonInteractiveHint: "kana reset --yes",
        prompt: RESET_CONFIRMATION_PROMPT,
      });
      if (!shouldReset) {
        log("Reset cancelled.");
        return;
      }

      const result = resetConfig(process.env);
      log(formatResetConfigMessage(result));
      log(`Reset config example: ${result.configExamplePath}`);
      log(`Reset MCP config: ${result.mcpConfigPath}`);
      log(`Reset MCP activation state: ${result.mcpEnabledPath}`);
      log(`Reset approvals: ${result.approvalsPath}`);
      log(`Reset skills config: ${result.skillsConfigPath}`);
    });

  program
    .command("update")
    .description("Update the installed Kana binary")
    .option("--check", "Check for an update without installing it")
    .action(async (commandOptions: { check?: boolean }) => {
      const result = await runUpdate({
        checkOnly: commandOptions.check,
        onProgress: (event) => {
          log(formatUpdateProgress(event));
        },
      });
      log(formatUpdateResult(result));
    });

  const authCommand = program.command("auth").description("Manage provider authentication");

  authCommand
    .command("login")
    .description("Sign in to a model provider")
    .argument("<provider>", "Provider name")
    .action(async (provider: string) => {
      requireOpenAICodexProvider(provider);
      await authorizeCodex();
      log("Authorized openai-codex.");
    });

  authCommand
    .command("status")
    .description("Show provider authentication status")
    .argument("<provider>", "Provider name")
    .action(async (provider: string) => {
      requireOpenAICodexProvider(provider);
      log(formatOAuthStatus("openai-codex", await getCodexAuthStatus()));
    });

  authCommand
    .command("logout")
    .description("Sign out from a model provider")
    .argument("<provider>", "Provider name")
    .action(async (provider: string) => {
      requireOpenAICodexProvider(provider);
      await signOutCodex();
      log("Signed out from openai-codex.");
    });

  const skillsCommand = program.command("skills").description("Manage Kana skills");

  skillsCommand
    .command("install")
    .description("Install or safely update the default Kana Skills repository")
    .action(async () => {
      log(formatInstallSkillsMessage(await installSkills(process.env)));
    });

  skillsCommand
    .command("reinstall")
    .description("Delete and clone the default Kana Skills repository again")
    .option("--yes", "Reinstall without interactive confirmation")
    .action(async (commandOptions: { yes?: boolean }) => {
      const shouldReinstall = await confirmDestructiveAction({
        confirmed: commandOptions.yes,
        confirm,
        interactive: isInteractive,
        nonInteractiveHint: "kana skills reinstall --yes",
        prompt: SKILLS_REINSTALL_CONFIRMATION_PROMPT,
      });
      if (!shouldReinstall) {
        log("Skills reinstall cancelled.");
        return;
      }

      log(formatInstallSkillsMessage(await reinstallSkills(process.env)));
    });

  skillsCommand
    .command("sync")
    .description("Copy installed Kana skills to another agent's skills directory")
    .argument("[target]", "Target agent preset, such as codex")
    .option("--target-dir <path>", "Copy to a custom skills directory")
    .action((targetAgent: string | undefined, commandOptions: { targetDir?: string }) => {
      const result = syncSkills(process.env, {
        targetAgent,
        targetDir: commandOptions.targetDir,
      });

      log(formatSyncKanaSkillsMessage("Synced", result));
    });

  skillsCommand
    .command("resync")
    .description("Replace matching skills in another agent's skills directory")
    .argument("[target]", "Target agent preset, such as codex")
    .option("--target-dir <path>", "Copy to a custom skills directory")
    .option("--yes", "Replace matching target Skills without interactive confirmation")
    .action(
      async (
        targetAgent: string | undefined,
        commandOptions: { targetDir?: string; yes?: boolean },
      ) => {
        const shouldResync = await confirmDestructiveAction({
          confirmed: commandOptions.yes,
          confirm,
          interactive: isInteractive,
          nonInteractiveHint: "kana skills resync <target> --yes",
          prompt: SKILLS_RESYNC_CONFIRMATION_PROMPT,
        });
        if (!shouldResync) {
          log("Skills resync cancelled.");
          return;
        }

        const result = resyncSkills(process.env, {
          targetAgent,
          targetDir: commandOptions.targetDir,
        });
        log(formatSyncKanaSkillsMessage("Resynced", result));
      },
    );

  return program;
}

type LaunchCommandOptions = {
  clean?: boolean;
};

type HeadlessCommandOptions = LaunchCommandOptions & {
  json?: boolean;
  allowAllTools?: boolean;
  timeout?: number;
};

function addHeadlessOptions(command: Command): Command {
  return command
    .option("--json", "Write versioned JSONL events to stdout")
    .option("--timeout <duration>", "Abort the Agent run after a duration such as 30m", (value) => {
      try {
        return parseHeadlessTimeout(value);
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    })
    .option(
      "--allow-all-tools",
      "Run tool calls without interactive approval (does not enable a sandbox)",
    );
}

function getHeadlessCommandOptions(
  actionOptions: HeadlessCommandOptions,
  command: Command,
): HeadlessCommandOptions {
  return {
    ...command.optsWithGlobals<HeadlessCommandOptions>(),
    ...command.parent?.opts<HeadlessCommandOptions>(),
    ...actionOptions,
  };
}

function getLaunchMode(options: LaunchCommandOptions): "clean" | undefined {
  return options.clean ? "clean" : undefined;
}

function joinPromptParts(promptParts: string[]): string | undefined {
  const prompt = promptParts.join(" ").trim();
  return prompt || undefined;
}

async function applyHeadlessExitCode(result: Promise<number>): Promise<void> {
  const exitCode = await result;
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

function requireOpenAICodexProvider(provider: string): void {
  if (provider !== "openai-codex") {
    throw new Error(`Provider ${provider} does not support Kana-managed authentication.`);
  }
}

function formatOAuthStatus(provider: string, status: OAuthSessionStatus): string {
  if (status.state === "unauthorized") {
    return `${provider}: unauthorized`;
  }

  const expiresAt =
    status.expiresAt === undefined ? "" : `, expires ${new Date(status.expiresAt).toISOString()}`;
  const refreshable = status.refreshable ? ", refreshable" : "";
  return `${provider}: ${status.state}${refreshable}${expiresAt}`;
}

function formatInstallSkillsMessage(
  result: InstallKanaSkillsResult | ReinstallKanaSkillsResult,
): string {
  switch (result.status) {
    case "cloned":
      return `Installed skills: ${result.skillsPath}`;
    case "updated":
      return `Updated skills: ${result.skillsPath}`;
    case "reinstalled":
      return `Reinstalled skills: ${result.skillsPath}`;
  }
}

function formatSyncKanaSkillsMessage(
  action: "Synced" | "Resynced",
  result: SyncKanaSkillsResult,
): string {
  const counts = result.skills.reduce(
    (summary, skill) => {
      summary[skill.status] += 1;
      return summary;
    },
    {
      copied: 0,
      exists: 0,
      replaced: 0,
    },
  );
  const parts = [
    `copied ${counts.copied}`,
    `replaced ${counts.replaced}`,
    `skipped ${counts.exists}`,
  ];
  const targetLabel = result.targetName === "custom" ? "custom target" : result.targetName;

  return `${action} skills to ${targetLabel}: ${result.targetPath} (${parts.join(", ")})`;
}

function formatInstallMessage(
  name: string,
  filePath: string,
  status: "created" | "exists" | "updated",
): string {
  switch (status) {
    case "created":
      return `Created ${name}: ${filePath}`;
    case "updated":
      return `Updated ${name}: ${filePath}`;
    case "exists":
      return `${capitalize(name)} already exists: ${filePath}`;
  }
}

function formatResetConfigMessage(result: ResetKanaConfigResult): string {
  return result.configRemoved
    ? `Removed config override: ${result.configPath}`
    : `Config override already absent: ${result.configPath}`;
}

function formatUpdateProgress(event: KanaUpdateProgressEvent): string {
  switch (event.phase) {
    case "checking":
      return `Checking for Kana updates (current ${event.currentVersion})...`;
    case "downloading":
      return `Downloading Kana ${event.version} for ${event.platform}...`;
    case "verifying":
      return `Verifying Kana ${event.version}...`;
    case "initializing":
      return `Refreshing Kana support files with ${event.version}...`;
    case "replacing":
      return `Replacing Kana executable: ${event.executablePath}`;
  }
}

function formatUpdateResult(result: KanaUpdateResult): string {
  switch (result.status) {
    case "up-to-date":
      return `Kana ${result.currentVersion} is already up to date.`;
    case "ahead":
      return `Kana ${result.currentVersion} is newer than the latest release ${result.latestVersion}.`;
    case "update-available":
      return `Kana ${result.latestVersion} is available (current ${result.currentVersion}).`;
    case "updated":
      return `Updated Kana from ${result.previousVersion} to ${result.currentVersion}.`;
  }
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

const RESET_CONFIRMATION_PROMPT = [
  "Reset Kana configuration?",
  "",
  "This will delete config.toml and overwrite:",
  "  - config.example.toml",
  "  - mcp.json",
  "  - mcp-enabled.json",
  "  - approvals.json",
  "  - skills/skills.toml",
  "",
  "OAuth tokens, sessions, memory, accounting, logs, AGENTS.md, and installed Skills will be preserved.",
].join("\n");

const SKILLS_REINSTALL_CONFIRMATION_PROMPT = [
  "Reinstall the default Kana Skills repository?",
  "",
  "This will delete the entire skills/kana-skills directory and clone it again.",
  "skills/skills.toml and other installed Skills will be preserved.",
].join("\n");

const SKILLS_RESYNC_CONFIRMATION_PROMPT = [
  "Replace matching Skills in the target directory?",
  "",
  "Each target Skill whose name matches the installed Kana repository will be deleted and copied again.",
  "Other target Skills, including stale Skills no longer present in the source, will be preserved.",
].join("\n");

type ConfirmDestructiveActionOptions = {
  confirmed: boolean | undefined;
  confirm: (message: string) => Promise<boolean>;
  interactive: () => boolean;
  nonInteractiveHint: string;
  prompt: string;
};

async function confirmDestructiveAction(
  options: ConfirmDestructiveActionOptions,
): Promise<boolean> {
  if (options.confirmed) {
    return true;
  }
  if (!options.interactive()) {
    throw new Error(
      `Refusing to run a destructive command in a non-interactive environment. Re-run with \`${options.nonInteractiveHint}\`.`,
    );
  }

  return options.confirm(options.prompt);
}

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function confirmInTerminal(message: string): Promise<boolean> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await readline.question(`${message}\n\nContinue? [y/N] `);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

export async function runCli(argv: string[], options: CreateCliOptions): Promise<void> {
  try {
    loadKanaEnvironment();
    await createCli(options).parseAsync(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
