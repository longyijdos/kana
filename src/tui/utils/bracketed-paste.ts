const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export type BracketedPasteResult = {
  text: string;
  remaining: string;
};

export class BracketedPasteBuffer {
  private buffer = "";
  private active = false;

  consume(data: string): BracketedPasteResult | undefined {
    if (data.includes(PASTE_START)) {
      this.active = true;
      this.buffer = "";
      data = data.replace(PASTE_START, "");
    }

    if (!this.active) {
      return undefined;
    }

    this.buffer += data;
    const endIndex = this.buffer.indexOf(PASTE_END);

    if (endIndex === -1) {
      return { text: "", remaining: "" };
    }

    const text = this.buffer.slice(0, endIndex);
    const remaining = this.buffer.slice(endIndex + PASTE_END.length);
    this.active = false;
    this.buffer = "";

    return { text, remaining };
  }
}
