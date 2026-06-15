import { Tui } from "../src/tui/runtime/tui";
import type { Terminal } from "../src/tui/runtime/terminal";
import {
  AssistantMessageBlock,
  TextBlock,
  Transcript,
} from "../src/tui/components";

class BenchmarkTerminal implements Terminal {
  columns = 100;
  rows = 24;

  start(): void {}

  stop(): void {}

  write(): void {}
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
  const pairCounts = [50, 100, 200, 400];

  console.log("TUI render benchmark");
  console.log("Each pair is one user TextBlock plus one assistant MarkdownBlock.");
  console.log("");
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
