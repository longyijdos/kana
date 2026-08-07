import type { EditorQueuedInput } from "../components";

type QueuedInput = EditorQueuedInput & {
  id: number;
};

export class QueuedInputController {
  private readonly inputs: QueuedInput[] = [];
  private nextId = 0;

  constructor(private readonly onChanged: (inputs: EditorQueuedInput[]) => void) {}

  add(content: string, delivery: EditorQueuedInput["delivery"]): number {
    const id = ++this.nextId;
    this.inputs.push({ id, content, delivery });
    this.publish();
    return id;
  }

  moveToRun(id: number): void {
    const index = this.inputs.findIndex((input) => input.id === id);
    if (index < 0) {
      return;
    }

    const [input] = this.inputs.splice(index, 1);
    if (!input) {
      return;
    }
    this.inputs.push({ ...input, delivery: "run" });
    this.publish();
  }

  remove(id: number): void {
    this.removeAt(this.inputs.findIndex((input) => input.id === id));
  }

  deliverTurn(content: string): void {
    this.removeAt(
      this.inputs.findIndex((input) => input.delivery === "turn" && input.content === content),
    );
  }

  startRun(content: string): void {
    const runIndex = this.inputs.findIndex(
      (input) => input.delivery === "run" && input.content === content,
    );
    if (runIndex >= 0) {
      this.removeAt(runIndex);
      return;
    }

    // A deferred steering input can start its fallback run before the awaiting
    // TUI continuation has moved its preview from the turn lane to the run lane.
    this.removeAt(this.inputs.findIndex((input) => input.content === content));
  }

  clear(): void {
    if (this.inputs.length === 0) {
      return;
    }
    this.inputs.length = 0;
    this.publish();
  }

  private removeAt(index: number): void {
    if (index < 0) {
      return;
    }
    this.inputs.splice(index, 1);
    this.publish();
  }

  private publish(): void {
    // Turn inputs are delivered before every follow-up run, regardless of the
    // order in which Enter and Tab were pressed.
    const ordered = [
      ...this.inputs.filter((input) => input.delivery === "turn"),
      ...this.inputs.filter((input) => input.delivery === "run"),
    ];
    this.onChanged(ordered.map(({ content, delivery }) => ({ content, delivery })));
  }
}
