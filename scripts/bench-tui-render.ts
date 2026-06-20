import type { Message } from "../src/core";
import { loadKanaSession } from "../src/kana";
import { addHistoryMessagesToTranscript } from "../src/tui/app/history";
import { AssistantMessageBlock, Editor, TextBlock, Transcript } from "../src/tui/components";
import type { TerminalNotification } from "../src/tui/runtime/notifications";
import type { Terminal } from "../src/tui/runtime/terminal";
import { Tui } from "../src/tui/runtime/tui";
import { tuiTheme } from "../src/tui/theme";

class BenchmarkTerminal implements Terminal {
  columns = 100;
  rows = 24;

  start(): void {}

  stop(): void {}

  write(): void {}

  notify(_notification: TerminalNotification): void {}
}

const MARKDOWN = [
  "# Heading",
  "Some **bold** text with `code` and a link [docs](https://example.com).",
  "中文内容用于覆盖宽字符显示宽度计算。",
  "",
  "```ts",
  "const value = 1;",
  "console.log(value);",
  "```",
  "",
].join("\n");

export function main(args: string[] = process.argv.slice(2)): void {
  const sessionId = parseSessionId(args);

  console.log("TUI render benchmark");
  console.log("Each pair is one user TextBlock plus one mixed ASCII/CJK assistant MarkdownBlock.");
  console.log("");
  runTranscriptBenchmark();

  if (sessionId) {
    console.log("");
    runSessionReplayBenchmark(sessionId);
  }

  console.log("");
  runEditorBenchmark();
}

export function parseSessionId(args: string[]): string | undefined {
  if (args.length === 0) {
    return undefined;
  }

  if (args[0] !== "--session" || !args[1] || args.length !== 2) {
    throw new Error("Usage: bun run bench:tui-render -- --session <session-id>");
  }

  return args[1];
}

function runTranscriptBenchmark(): void {
  const pairCounts = [50, 100, 200, 400];

  console.log("pairs  lines  cold transcript  hot transcript  hot renderNow");

  for (const pairCount of pairCounts) {
    const transcript = createTranscript(pairCount);
    const lineCount = transcript.render(100).length;
    const coldTranscript = measureColdTranscript(pairCount);
    const hotTranscript = measure(() => transcript.render(100), 20);
    const hotRenderNow = measureHotRenderNow(transcript, 20);

    console.log(
      [
        pairCount.toString().padStart(5),
        lineCount.toString().padStart(5),
        formatMs(coldTranscript).padStart(15),
        formatMs(hotTranscript).padStart(14),
        formatMs(hotRenderNow).padStart(13),
      ].join("  "),
    );
  }
}

function runSessionReplayBenchmark(sessionId: string): void {
  const session = loadKanaSession(sessionId);
  const transcript = createSessionTranscript(sessionId, session.messages);
  const lineCount = transcript.render(100).length;
  const coldReplay = measure(
    () => createSessionTranscript(sessionId, session.messages).render(100),
    5,
  );
  const hotTranscript = measure(() => transcript.render(100), 20);
  const hotRenderNow = measureHotRenderNow(transcript, 20);

  console.log(`Session replay benchmark: ${session.metadata.id}`);
  console.log(`messages: ${session.messages.length}  lines: ${lineCount}`);
  console.log("cold replay  hot transcript  hot renderNow");
  console.log(
    [
      formatMs(coldReplay).padStart(11),
      formatMs(hotTranscript).padStart(14),
      formatMs(hotRenderNow).padStart(13),
    ].join("  "),
  );
}

function runEditorBenchmark(): void {
  const sizes = [1_000, 5_000, 10_000];

  console.log("Editor typing benchmark");
  console.log("Input is multiline text with the cursor at the end.");
  console.log("");
  console.log("chars  lines  iters  render only  handleInput only  type + render");

  for (const size of sizes) {
    const input = createEditorInput(size);
    const lineCount = input.split("\n").length;
    const iterations = editorBenchmarkIterations(size);
    const renderOnly = measureEditorRender(input, iterations);
    const handleInputOnly = measureEditorHandleInput(input, iterations);
    const typeAndRender = measureEditorTypeAndRender(input, iterations);

    console.log(
      [
        size.toString().padStart(5),
        lineCount.toString().padStart(5),
        iterations.toString().padStart(5),
        formatMs(renderOnly).padStart(11),
        formatMs(handleInputOnly).padStart(16),
        formatMs(typeAndRender).padStart(13),
      ].join("  "),
    );
  }
}

function editorBenchmarkIterations(size: number): number {
  if (size >= 10_000) {
    return 5;
  }

  if (size >= 5_000) {
    return 10;
  }

  return 50;
}

function createTranscript(pairCount: number): Transcript {
  const transcript = new Transcript();

  for (let index = 0; index < pairCount; index += 1) {
    transcript.addChild(
      new TextBlock(`用户 ${index}: ${"hello 世界 ".repeat(12)}`, {
        prefix: "> ",
      }),
    );

    const assistant = new AssistantMessageBlock();
    assistant.update({
      role: "assistant",
      content: [
        {
          type: "text",
          text: MARKDOWN.repeat(2),
        },
      ],
    });
    transcript.addChild(assistant);
  }

  return transcript;
}

export function createSessionTranscript(sessionId: string, messages: Message[]): Transcript {
  const transcript = new Transcript();

  // Match the restored-session UI so benchmark results include its real blocks.
  transcript.addChild(
    new TextBlock(`Resumed session ${sessionId}.`, {
      color: tuiTheme.muted,
    }),
  );
  addHistoryMessagesToTranscript(transcript, messages);

  return transcript;
}

function measureColdTranscript(pairCount: number): number {
  return measure(() => createTranscript(pairCount).render(100), 5);
}

function measureHotRenderNow(transcript: Transcript, iterations: number): number {
  const tui = new Tui(new BenchmarkTerminal());
  const renderNow = (tui as unknown as { renderNow(): void }).renderNow.bind(tui);

  tui.addChild(transcript);
  tui.start();
  renderNow();

  return measure(() => renderNow(), iterations);
}

function measureEditorRender(input: string, iterations: number): number {
  const editor = createEditor(input);

  return measure(() => editor.render(100), iterations);
}

function measureEditorHandleInput(input: string, iterations: number): number {
  const editor = createEditor(input);

  return measure(() => editor.handleInput("x"), iterations);
}

function measureEditorTypeAndRender(input: string, iterations: number): number {
  const editor = createEditor(input);

  return measure(() => {
    editor.handleInput("x");
    editor.render(100);
  }, iterations);
}

function createEditor(input: string): Editor {
  const editor = new Editor();

  editor.setText(input);
  editor.render(100);

  return editor;
}

function createEditorInput(targetChars: number): string {
  const line = "abcdefghijklmnopqrstuvwxyz0123456789 中文输入".repeat(2);
  const lines: string[] = [];
  let length = 0;

  while (length < targetChars) {
    lines.push(line);
    length += line.length + 1;
  }

  return lines.join("\n").slice(0, targetChars);
}

function measure(callback: () => unknown, iterations: number): number {
  const start = performance.now();

  for (let index = 0; index < iterations; index += 1) {
    callback();
  }

  return (performance.now() - start) / iterations;
}

function formatMs(value: number): string {
  return `${value.toFixed(2)}ms`;
}

if (import.meta.main) {
  main();
}
