export type InlineLatexToken = {
  end: number;
  pending: boolean;
  raw: string;
  text: string;
};

export type BlockLatexToken = {
  nextLine: number;
  pending: boolean;
  raw: string;
  text: string;
};

export function readInlineLatex(value: string, start: number): InlineLatexToken | undefined {
  if (value[start] !== "$" && value[start] !== "\\") {
    return undefined;
  }
  if (isEscaped(value, start)) {
    return undefined;
  }

  const source = value.slice(start);
  let opening = "";
  let closing = "";

  if (source.startsWith("$$")) {
    opening = "$$";
    closing = "$$";
  } else if (source.startsWith("\\(")) {
    opening = "\\(";
    closing = "\\)";
  } else if (source.startsWith("\\[")) {
    opening = "\\[";
    closing = "\\]";
  } else if (source.startsWith("$") && !/^\$\s/.test(source)) {
    opening = "$";
    closing = "$";
  } else {
    return undefined;
  }

  const closingIndex = findClosingDelimiter(source, closing, opening.length);
  if (closingIndex >= 0 && opening === "$" && isAmbiguousDollarMath(source, closingIndex)) {
    return undefined;
  }

  if (closingIndex < 0) {
    const text = source.slice(opening.length);

    // Reserve likely partial math as one literal span so Markdown punctuation
    // inside a streamed expression cannot acquire transient styling.
    if (opening.startsWith("\\") || looksLikePendingDollarMath(text)) {
      return {
        end: value.length,
        pending: true,
        raw: source,
        text,
      };
    }
    return undefined;
  }

  const text = source.slice(opening.length, closingIndex);
  if (!text || text.includes("\n") || text.includes("\r")) {
    return undefined;
  }

  const raw = source.slice(0, closingIndex + closing.length);
  return {
    end: start + raw.length,
    pending: false,
    raw,
    text,
  };
}

export function readBlockLatex(
  sourceLines: readonly string[],
  startLine: number,
): BlockLatexToken | undefined {
  if (!/^ {0,3}(?:\$\$|\\\[)/.test(sourceLines[startLine] ?? "")) {
    return undefined;
  }

  const source = sourceLines.slice(startLine).join("\n");
  const complete = readCompleteBlockLatex(source);

  if (complete) {
    return {
      ...complete,
      nextLine: nextSourceLine(startLine, complete.raw),
      pending: false,
    };
  }

  const bracket = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
  if (bracket) {
    return {
      nextLine: sourceLines.length,
      pending: true,
      raw: bracket[0],
      text: bracket[1] ?? "",
    };
  }

  const dollar = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
  if (dollar?.[1] && looksLikePendingDollarMath(dollar[1])) {
    return {
      nextLine: sourceLines.length,
      pending: true,
      raw: dollar[0],
      text: dollar[1],
    };
  }

  return undefined;
}

function readCompleteBlockLatex(source: string): Pick<BlockLatexToken, "raw" | "text"> | undefined {
  const dollar = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(source);
  if (dollar?.[1]) {
    return { raw: dollar[0], text: dollar[1].trim() };
  }

  const bracket = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(source);
  if (bracket?.[1]) {
    return { raw: bracket[0], text: bracket[1].trim() };
  }

  return undefined;
}

function nextSourceLine(startLine: number, raw: string): number {
  const lineBreaks = raw.match(/\n/g)?.length ?? 0;
  return startLine + lineBreaks + (raw.endsWith("\n") ? 0 : 1);
}

function findClosingDelimiter(source: string, closing: string, start: number): number {
  let index = source.indexOf(closing, start);
  while (index >= 0 && isEscaped(source, index)) {
    index = source.indexOf(closing, index + closing.length);
  }
  return index;
}

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let position = index - 1; position >= 0 && source[position] === "\\"; position -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function looksLikePendingDollarMath(source: string): boolean {
  return /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/.test(source);
}

function isAmbiguousDollarMath(source: string, closingIndex: number): boolean {
  const text = source.slice(1, closingIndex);
  const trailing = source.slice(closingIndex + 1);

  return (
    /\s$/.test(text) ||
    /^\d/.test(trailing) ||
    (/^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(text) &&
      /^[A-Za-z_][A-Za-z0-9_]*/.test(trailing)) ||
    text.includes("`")
  );
}
