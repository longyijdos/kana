import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { createPromptAssembly } from "@/agent";
import type { Tool } from "@/tools";

const parameters = Type.Object({});

function createTool(name: string): Tool<typeof parameters, string> {
  return {
    name,
    description: `${name} tool`,
    parameters,
    execute: () => ({ content: name, result: name }),
  };
}

describe("PromptAssembly", () => {
  test("preserves named section order and refreshes dynamic capabilities", async () => {
    const initialTool = createTool("initial");
    const refreshedTool = createTool("refreshed");
    let environment = "day one";
    let tools: readonly Tool[] = [initialTool];
    const assembly = createPromptAssembly({
      system: [
        { name: "assistant", content: "Assistant rules.\n" },
        { name: "project", content: "Project rules." },
      ],
      context: [
        {
          name: "environment",
          render: () => ({ status: "active", content: environment }),
        },
        {
          name: "empty",
          render: () => ({ status: "inactive", content: "No optional context is active." }),
        },
      ],
      tools: [
        {
          name: "external",
          tools: [initialTool],
          resolve: () => tools,
        },
      ],
    });
    const signal = new AbortController().signal;

    expect(assembly.initialSystem).toContain("Assistant rules.\n\nProject rules.");
    expect(assembly.initialSystem).toContain(
      "For each source, only its latest runtime_context message is authoritative.",
    );
    expect(assembly.initialTools).toEqual([initialTool]);
    expect(Object.isFrozen(assembly)).toBe(true);
    expect(Object.isFrozen(assembly.systemSections)).toBe(true);
    expect(Object.isFrozen(assembly.contextSections)).toBe(true);
    expect(Object.isFrozen(assembly.toolSections)).toBe(true);

    expect(await assembly.assemble({ signal })).toEqual({
      system: assembly.initialSystem,
      context: [
        { source: "environment", status: "active", content: "day one" },
        {
          source: "empty",
          status: "inactive",
          content: "No optional context is active.",
        },
      ],
      tools: [initialTool],
    });

    environment = "day two\n";
    tools = [refreshedTool];

    expect(await assembly.assemble({ signal })).toEqual({
      system: assembly.initialSystem,
      context: [
        { source: "environment", status: "active", content: "day two" },
        {
          source: "empty",
          status: "inactive",
          content: "No optional context is active.",
        },
      ],
      tools: [refreshedTool],
    });
  });

  test("rejects duplicate section and tool names", async () => {
    expect(() =>
      createPromptAssembly({
        context: [
          { name: "environment", render: () => ({ status: "active", content: "first" }) },
          { name: "environment", render: () => ({ status: "active", content: "second" }) },
        ],
      }),
    ).toThrow("Duplicate prompt context section name: environment.");

    const duplicateTool = createTool("duplicate");
    expect(() =>
      createPromptAssembly({
        tools: [
          { name: "first", tools: [duplicateTool] },
          { name: "second", tools: [duplicateTool] },
        ],
      }),
    ).toThrow("Duplicate prompt tool name: duplicate.");

    const assembly = createPromptAssembly({
      tools: [
        {
          name: "dynamic",
          tools: [],
          resolve: () => [duplicateTool, duplicateTool],
        },
      ],
    });
    await expect(assembly.assemble({ signal: new AbortController().signal })).rejects.toThrow(
      "Duplicate prompt tool name: duplicate.",
    );
  });

  test("does not resolve sections after cancellation", async () => {
    let renders = 0;
    const assembly = createPromptAssembly({
      context: [
        {
          name: "environment",
          render: () => {
            renders += 1;
            return { status: "active", content: "unused" };
          },
        },
      ],
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(assembly.assemble({ signal: controller.signal })).rejects.toThrow("cancelled");
    expect(renders).toBe(0);
  });

  test("requires every context source to return an explicit non-empty state", async () => {
    const signal = new AbortController().signal;
    const missing = createPromptAssembly({
      context: [{ name: "missing", render: () => undefined as never }],
    });
    const empty = createPromptAssembly({
      context: [{ name: "empty", render: () => ({ status: "inactive", content: " " }) }],
    });

    await expect(missing.assemble({ signal })).rejects.toThrow(
      "Prompt context section missing must return an explicit non-empty state.",
    );
    await expect(empty.assemble({ signal })).rejects.toThrow(
      "Prompt context section empty must return an explicit non-empty state.",
    );
  });
});
