import { CodemodeSandbox, type CodemodeTool, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import quickJSWasmPath from "quickjs-wasi/quickjs.wasm" with { type: "file" };

export function createCodemodeSandbox(options: {
  tools: CodemodeTool[];
  timeoutMs?: number;
}): CodemodeSandbox {
  return new CodemodeSandbox({
    tools: options.tools,
    timeoutMs: options.timeoutMs,
    memoryLimitBytes: 256 * 1_024 * 1_024,
    wasm: loadQuickJSWasm(quickJSWasmPath),
    workerUrl: Bun.isStandaloneExecutable
      ? "./src/tools/codemode/worker.ts"
      : new URL("./worker.ts", import.meta.url),
  });
}
