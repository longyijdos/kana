import { Marked, type Token, Tokenizer, type TokenizerExtension, type Tokens } from "marked";
import markedCjkFriendly from "marked-cjk-friendly";
import { readBlockLatex, readInlineLatex } from "./markdown-latex";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

export interface MarkdownLatexToken extends Tokens.Generic {
  pending: boolean;
  text: string;
  type: "latex";
}

export interface MarkdownBlockLatexToken extends Tokens.Generic {
  pending: boolean;
  text: string;
  type: "latexBlock";
}

class KanaMarkdownTokenizer extends Tokenizer {
  override lheading(): undefined {
    // Kana has always treated underline-like lines as thematic rules, not
    // setext headings, so keep that product contract while using Marked.
    return undefined;
  }

  override del(src: string): Tokens.Del | undefined {
    const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
    if (!match) {
      return undefined;
    }

    const text = match[2] ?? "";
    return {
      raw: match[0],
      text,
      tokens: this.lexer.inlineTokens(text),
      type: "del",
    };
  }
}

const inlineLatexExtension: TokenizerExtension = {
  level: "inline",
  name: "latex",
  start(source) {
    const indices = [source.indexOf("$"), source.indexOf("\\("), source.indexOf("\\[")].filter(
      (index) => index >= 0,
    );
    return indices.length > 0 ? Math.min(...indices) : undefined;
  },
  tokenizer(source) {
    const token = readInlineLatex(source, 0);
    if (!token) {
      return undefined;
    }

    return {
      pending: token.pending,
      raw: token.raw,
      text: token.text,
      type: "latex",
    } satisfies MarkdownLatexToken;
  },
};

const blockLatexExtension: TokenizerExtension = {
  level: "block",
  name: "latexBlock",
  start(source) {
    const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source);
    return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : undefined;
  },
  tokenizer(source) {
    const token = readBlockLatex(source.split(/\r\n|\r|\n/), 0);
    if (!token) {
      return undefined;
    }

    return {
      pending: token.pending,
      raw: token.raw,
      text: token.text,
      type: "latexBlock",
    } satisfies MarkdownBlockLatexToken;
  },
};

const markdownParser = new Marked();
markdownParser.setOptions({ tokenizer: new KanaMarkdownTokenizer() });
const cjkFriendlyTokenizer = markedCjkFriendly().tokenizer as Pick<Tokenizer, "emStrong">;
markdownParser.use({ tokenizer: { emStrong: cjkFriendlyTokenizer.emStrong } });
markdownParser.use({ extensions: [blockLatexExtension, inlineLatexExtension] });

export function lexMarkdown(value: string): Token[] {
  return markdownParser.lexer(value);
}

export function lexMarkdownInline(value: string): Token[] {
  return new markdownParser.Lexer(markdownParser.defaults).inlineTokens(value);
}
