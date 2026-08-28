import { describe, expect, test } from "bun:test";
import { createBashTool } from "../../src/tools/bash";
import { createEditTool } from "../../src/tools/edit";
import { createGlobTool } from "../../src/tools/glob";
import { createGrepTool } from "../../src/tools/grep";
import { createListTool } from "../../src/tools/list";
import { createReadTool } from "../../src/tools/read";
import { createViewImageTool } from "../../src/tools/view-image";
import { createWriteTool } from "../../src/tools/write";

describe("workspace tool execution", () => {
  test("declares only read-only workspace tools as parallel", () => {
    const parallelTools = [
      createReadTool(),
      createListTool(),
      createGlobTool(),
      createGrepTool(),
      createViewImageTool(),
    ];
    const exclusiveByDefault = [createWriteTool(), createEditTool(), createBashTool()];

    expect(parallelTools.map((tool) => tool.execution?.concurrency)).toEqual([
      "parallel",
      "parallel",
      "parallel",
      "parallel",
      "parallel",
    ]);
    expect(exclusiveByDefault.map((tool) => tool.execution?.concurrency)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});
