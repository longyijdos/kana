import { AssistantMessageBlock, Editor, TextBlock, Transcript } from "../src/tui/components";
import type { TerminalNotification } from "../src/tui/runtime/notifications";
import type { Terminal } from "../src/tui/runtime/terminal";
import { Tui } from "../src/tui/runtime/tui";

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
  "",
  "```ts",
  "const value = 1;",
  "console.log(value);",
  "```",
  "",
].join("\n");

function main(): void {
  console.log("TUI render benchmark");
  console.log("Each pair is one user TextBlock plus one assistant MarkdownBlock.");
  console.log("");
  runTranscriptBenchmark();
  console.log("");
  runEditorBenchmark();
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
      new TextBlock(`user ${index}: ${"hello ".repeat(20)}`, {
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
  const line = "abcdefghijklmnopqrstuvwxyz0123456789".repeat(2);
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

main();
