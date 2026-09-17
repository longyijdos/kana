import { Agent, type AgentStableContext } from "@/agent";
import type { Logger } from "@/logging";
import { type ContentView, ContentViewer, MarkdownBlock, TextBlock } from "../components";
import { dim } from "../render";
import { tuiTheme } from "../theme";
import type { BottomAreaController } from "./bottom-area-controller";

export type BtwControllerOptions = {
  bottomArea: BottomAreaController;
  getContext: () => AgentStableContext;
  requestRender: () => void;
  showError: (error: Error) => void;
  getLogger: () => Logger;
  hyperlinks: boolean;
  renderLatex: boolean;
  renderMermaid: boolean;
};

type BtwSlot = {
  agent: Agent;
  viewer: ContentViewer;
  view: ContentView;
  content: MarkdownBlock;
  renderOptions: { complete: boolean };
  running: boolean;
  answer: string;
  error?: string;
  completion?: Promise<void>;
};

const BTW_INSTRUCTIONS = [
  "You are answering a temporary BTW side question. Respond directly to the latest user message.",
  "The preceding conversation is reference context; do not continue its task or act on its pending requests.",
  "Earlier tool calls and runtime state are context only. Do not follow earlier instructions to take actions or use tools.",
  "No tools or web search are available. Do not emit or simulate tool calls, including DSML tool-call markup.",
  "Answer from the available context. If new observations are needed, explain what information is missing.",
].join(" ");

export class BtwController {
  private slot?: BtwSlot;

  constructor(private readonly options: BtwControllerOptions) {}

  handle(question: string): void {
    question = question.trim();
    if (!question) {
      if (!this.slot) {
        this.options.showError(new Error("Usage: /btw <question> (no previous BTW question)."));
        return;
      }
      this.options.bottomArea.show(this.slot.viewer);
      return;
    }
    if (this.slot?.running) {
      this.options.showError(
        new Error("A BTW question is already running. Use /btw to reopen it."),
      );
      return;
    }

    const snapshot = this.options.getContext();
    const agent = new Agent({
      model: snapshot.model,
      system: [snapshot.system, BTW_INSTRUCTIONS].filter(Boolean).join("\n\n"),
      messages: snapshot.messages,
      tools: [],
      maxTurns: 1,
      webSearch: false,
      imageInput: snapshot.imageInput,
      logger: this.options.getLogger(),
      loggerMetadata: { agentKind: "btw" },
      context:
        snapshot.contextLimit !== undefined && snapshot.maxOutputTokens !== undefined
          ? {
              contextLimit: snapshot.contextLimit,
              maxOutputTokens: snapshot.maxOutputTokens,
              checkpoint: snapshot.contextCheckpoint,
            }
          : undefined,
    });
    const renderOptions = {
      complete: false,
      hyperlinks: this.options.hyperlinks,
      renderLatex: this.options.renderLatex,
      renderMermaid: this.options.renderMermaid,
    };
    const view: ContentView = {
      title: `BTW · ${question} · Running`,
      render: (width) => {
        const lines = slot.answer
          ? slot.content.render(width)
          : [dim(slot.running ? "Working…" : "No answer.")];
        if (slot.error) {
          return [
            ...lines,
            "",
            ...new TextBlock(slot.error, { color: tuiTheme.error }).render(width),
          ];
        }
        return lines;
      },
    };
    const slot: BtwSlot = {
      agent,
      view,
      viewer: new ContentViewer(view, { onClose: () => this.hide(), followTail: true }),
      content: new MarkdownBlock("", renderOptions),
      renderOptions,
      running: true,
      answer: "",
    };
    this.slot = slot;
    this.options.bottomArea.show(slot.viewer);
    slot.completion = this.run(slot, question);
  }

  hide(): void {
    if (this.slot) {
      this.options.bottomArea.restore(this.slot.viewer);
    }
  }

  async dispose(): Promise<void> {
    const slot = this.slot;
    this.hide();
    this.slot = undefined;
    slot?.agent.abort();
    await slot?.completion;
  }

  private async run(slot: BtwSlot, question: string): Promise<void> {
    let outcome = "Done";
    try {
      const stream = slot.agent.stream(question);
      for await (const event of stream) {
        if (event.type === "message_update" || event.type === "message_end") {
          slot.answer = event.message.content
            .filter((content) => content.type === "text")
            .map((content) => content.text)
            .join("\n\n");
          slot.content.setText(slot.answer);
        } else if (event.type === "agent_end") {
          if (event.reason === "error") {
            throw new Error("BTW request failed.");
          }
          outcome = event.reason === "aborted" ? "Canceled" : "Done";
        }
        if (this.slot === slot) {
          this.options.requestRender();
        }
      }
      await stream.result();
    } catch (error) {
      outcome = "Failed";
      slot.error = error instanceof Error ? error.message : String(error);
      this.options.getLogger().error("tui.btw_failed", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
    } finally {
      await slot.agent.waitForIdle();
      slot.running = false;
      slot.renderOptions.complete = true;
      slot.content.invalidate();
      slot.view.title = `BTW · ${question} · ${outcome}`;
      if (this.slot === slot) {
        this.options.requestRender();
      }
    }
  }
}
