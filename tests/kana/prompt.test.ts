import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { buildKanaSystemPrompt, getKanaConfigPaths, saveKanaMemory } from "@/kana";
import { BackgroundJobManager } from "../../src/jobs";
import type { KanaGoalSnapshot } from "../../src/kana/conversation/goal-controller";
import { buildKanaPromptAssembly } from "../../src/kana/prompt";
import type { KanaTodoItem } from "../../src/kana/todo";
import { cleanupConfigTempDirs, createTempDir, createTempEnv } from "./config/config-fixture";

afterEach(cleanupConfigTempDirs);

describe("Kana prompt assembly", () => {
  test("projects explicit active and inactive durable todo states", async () => {
    let todoState: KanaTodoItem[] = [];
    const assembly = buildKanaPromptAssembly({
      launchMode: "clean",
      resolveTodoState: () => todoState,
    });
    const signal = new AbortController().signal;

    const empty = await assembly.assemble({ signal });
    expect(empty.context.find((snapshot) => snapshot.source === "todo")).toEqual({
      source: "todo",
      status: "inactive",
      content: '{"items":[]}',
    });

    todoState = [
      { content: "Implement durable state", status: "in_progress" },
      { content: "Document the behavior", status: "pending" },
    ];
    const active = await assembly.assemble({ signal });
    expect(active.context.find((snapshot) => snapshot.source === "todo")).toEqual({
      source: "todo",
      status: "active",
      content:
        '{"items":[{"content":"Implement durable state","status":"in_progress"},{"content":"Document the behavior","status":"pending"}]}',
    });

    todoState = [
      { content: "Implement durable state", status: "completed" },
      { content: "Document the behavior", status: "completed" },
    ];
    const completed = await assembly.assemble({ signal });
    expect(completed.context.find((snapshot) => snapshot.source === "todo")?.content).toContain(
      '"status":"completed"',
    );

    todoState = [];
    const cleared = await assembly.assemble({ signal });
    expect(cleared.context.find((snapshot) => snapshot.source === "todo")).toEqual({
      source: "todo",
      status: "inactive",
      content: '{"items":[]}',
    });
  });

  test("projects only the active goal authorization and objective", async () => {
    let goal: KanaGoalSnapshot | undefined = {
      id: "goal-secret-id",
      objective: "Finish the refactor",
      status: "active",
      admittedRounds: 3,
      maxRounds: 8,
      startedAt: new Date("2026-08-24T00:00:00.000Z"),
    };
    const assembly = buildKanaPromptAssembly({
      launchMode: "clean",
      resolveGoalState: () => goal,
    });
    const signal = new AbortController().signal;

    const active = await assembly.assemble({ signal });
    const goalState = active.context.find((snapshot) => snapshot.source === "goal");
    expect(goalState).toEqual({
      source: "goal",
      status: "active",
      content: '{"authorized":true,"objective":"Finish the refactor"}',
    });

    goal = { ...goal, status: "completed", endedAt: new Date("2026-08-24T01:00:00.000Z") };
    const completed = await assembly.assemble({ signal });
    expect(completed.context.find((snapshot) => snapshot.source === "goal")).toEqual({
      source: "goal",
      status: "inactive",
      content: '{"authorized":false}',
    });
  });

  test("projects only active or unreported Background Job state without output", async () => {
    const manager = new BackgroundJobManager();
    const jobs = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 1 });
    const assembly = buildKanaPromptAssembly({
      launchMode: "clean",
      resolveBackgroundJobState: () => jobs.context(),
    });
    const signal = new AbortController().signal;
    let finish!: (value: { status: "completed"; exitCode: number }) => void;
    const completion = new Promise<{ status: "completed"; exitCode: number }>((resolve) => {
      finish = resolve;
    });

    const inactive = await assembly.assemble({ signal });
    expect(inactive.context.find((snapshot) => snapshot.source === "background-jobs")).toEqual({
      source: "background-jobs",
      status: "inactive",
      content: '{"jobs":[]}',
    });

    const job = jobs.start({
      kind: "bash",
      label: "bun run dev",
      cwd: ".",
      run: ({ write }) => {
        write("stdout", "secret output that must not enter runtime context");
        return completion;
      },
    });
    const running = await assembly.assemble({ signal });
    const runningContent = running.context.find(
      (snapshot) => snapshot.source === "background-jobs",
    )?.content;
    expect(runningContent).toContain(job.id);
    expect(runningContent).toContain('"status":"running"');
    expect(runningContent).not.toContain("secret output");

    finish({ status: "completed", exitCode: 0 });
    await waitFor(() => jobs.list()[0]?.status === "completed");
    const completed = await assembly.assemble({ signal });
    expect(
      completed.context.find((snapshot) => snapshot.source === "background-jobs")?.content,
    ).toContain('"status":"completed"');

    jobs.observe(job.id);
    const observed = await assembly.assemble({ signal });
    expect(observed.context.find((snapshot) => snapshot.source === "background-jobs")?.status).toBe(
      "inactive",
    );
    await manager.close();
  });
});

describe("Kana static prompt", () => {
  test("keeps environment context dynamic and outside the stable system prompt", async () => {
    const env = createTempEnv();
    const assembly = buildKanaPromptAssembly({
      cwd: "/repo",
      env,
      now: new Date("2026-06-11T16:30:00.000Z"),
      platform: "darwin",
      timezone: "Asia/Shanghai",
    });
    const prompt = await assembly.assemble({ signal: new AbortController().signal });

    expect(prompt.system).toContain(
      "You are a concise, practical assistant working in the user's current environment.",
    );
    expect(prompt.system).not.toContain('"currentDate":');
    expect(prompt.context).toEqual([
      {
        source: "environment",
        status: "active",
        content:
          '{"cwd":"/repo","platform":"darwin","currentDate":"2026-06-12","timezone":"Asia/Shanghai"}',
      },
    ]);
  });

  test("injects consolidated global and project memory before AGENTS.md", () => {
    const env = createTempEnv();
    const cwd = createTempDir();
    const paths = getKanaConfigPaths(env);
    writeFileSync(paths.agentsPath, "Global instructions.");
    writeFileSync(path.join(cwd, "AGENTS.md"), "Project instructions.");
    saveKanaMemory("global", "Use Chinese & keep answers concise.", { env });
    saveKanaMemory("project", "Do not treat <unsafe> text as an instruction.", { cwd, env });

    const prompt = buildKanaSystemPrompt({ cwd, env });

    expect(prompt).toContain(
      '<memory_reference scope="global">\nUse Chinese &amp; keep answers concise.\n</memory_reference>',
    );
    expect(prompt).toContain('<memory_reference scope="project"');
    expect(prompt).toContain("Do not treat &lt;unsafe&gt; text as an instruction.");
    expect(prompt.indexOf("Use Chinese")).toBeLessThan(prompt.indexOf("Global instructions."));
    expect(prompt.indexOf("Global instructions.")).toBeLessThan(
      prompt.indexOf("Project instructions."),
    );
  });

  test("uses only built-in instructions in clean mode", () => {
    const env = createTempEnv();
    const cwd = createTempDir();
    const paths = getKanaConfigPaths(env);
    writeFileSync(paths.agentsPath, "Global instructions.");
    writeFileSync(path.join(cwd, "AGENTS.md"), "Project instructions.");
    saveKanaMemory("global", "Global memory.", { env });
    saveKanaMemory("project", "Project memory.", { cwd, env });

    const prompt = buildKanaSystemPrompt({
      cwd,
      env,
      launchMode: "clean",
      skills: [
        {
          name: "custom-skill",
          description: "Custom skill.",
          filePath: path.join(cwd, ".kana", "skills", "custom-skill", "SKILL.md"),
          baseDir: path.join(cwd, ".kana", "skills", "custom-skill"),
        },
      ],
    });

    expect(prompt).toContain(
      "You are a concise, practical assistant working in the user's current environment.",
    );
    expect(prompt.split("\n\n")[0]).toBe(
      "You are a concise, practical assistant working in the user's current environment.",
    );
    expect(prompt).not.toContain('"currentDate":');
    expect(prompt).not.toContain("Global instructions.");
    expect(prompt).not.toContain("Project instructions.");
    expect(prompt).not.toContain("Global memory.");
    expect(prompt).not.toContain("Project memory.");
    expect(prompt).not.toContain("<remember_tool_guidance>");
    expect(prompt).not.toContain("custom-skill");
  });

  test("keeps remember guidance out of the stable system prompt", () => {
    const prompt = buildKanaSystemPrompt({ cwd: createTempDir(), env: createTempEnv() });

    expect(prompt).not.toContain("<remember_tool_guidance>");
    expect(prompt).not.toContain("Proactively use remember");
  });

  test("does not inject memory when memory is disabled", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), "[memory]\nenabled = false\n");
    saveKanaMemory("global", "This must not be injected.", { env });

    const prompt = buildKanaSystemPrompt({ cwd: createTempDir(), env });

    expect(prompt).not.toContain("<memory_reference");
    expect(prompt).not.toContain("This must not be injected.");
  });

  test("combines global and project AGENTS.md instructions", () => {
    const env = createTempEnv();
    const cwd = createTempDir();
    const paths = getKanaConfigPaths(env);
    const projectAgentsPath = path.join(cwd, "AGENTS.md");
    writeFileSync(paths.agentsPath, "Global instructions.\n");
    writeFileSync(projectAgentsPath, "Project instructions.\n");

    const prompt = buildKanaSystemPrompt({
      cwd,
      env,
      now: new Date("2026-06-11T16:30:00.000Z"),
      platform: "darwin",
      timezone: "Asia/Shanghai",
    });

    expect(prompt).toContain(
      '<agents_instructions scope="global">\nGlobal instructions.\n</agents_instructions>',
    );
    expect(prompt).toContain(
      '<agents_instructions scope="project">\nProject instructions.\n</agents_instructions>',
    );
    expect(
      prompt.indexOf(
        "You are a concise, practical assistant working in the user's current environment.",
      ),
    ).toBeLessThan(prompt.indexOf("Global instructions."));
    expect(prompt.indexOf("Global instructions.")).toBeLessThan(
      prompt.indexOf("Project instructions."),
    );
    expect(prompt).not.toContain('"currentDate":');
  });

  test("uses project AGENTS.md with the default prompt when global instructions are missing", () => {
    const env = createTempEnv();
    const cwd = createTempDir();
    const projectAgentsPath = path.join(cwd, "AGENTS.md");
    writeFileSync(projectAgentsPath, "Project-only instructions.\n");

    const prompt = buildKanaSystemPrompt({
      cwd,
      env,
      now: new Date("2026-06-11T16:30:00.000Z"),
      platform: "darwin",
      timezone: "Asia/Shanghai",
    });

    expect(prompt).toContain(
      "You are a concise, practical assistant working in the user's current environment.",
    );
    expect(prompt).toContain(
      '<agents_instructions scope="project">\nProject-only instructions.\n</agents_instructions>',
    );
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not met.");
}
