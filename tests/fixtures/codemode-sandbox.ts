import { createCodemodeSandbox } from "../../src/tools";

const sandbox = createCodemodeSandbox({
  tools: [{ name: "echo", execute: async (args) => args }],
  timeoutMs: 5_000,
});

try {
  const result = await sandbox.execute(`
    const item = await tools.echo({ value: 42 });
    text(item.value);
    return { value: item.value, process: typeof process };
  `);
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
} finally {
  await sandbox.close();
}
