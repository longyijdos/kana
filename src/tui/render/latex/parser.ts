/*
 * Adapted from @earendil-works/pi-tui's terminal LaTeX renderer.
 *
 * MIT License
 *
 * Copyright (c) 2025 Mario Zechner
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { visibleWidth } from "../width";
import {
  formatFraction,
  formatRoot,
  formatScript,
  formatUnicodeScript,
  LAYOUT_MARKER_END,
  LAYOUT_MARKER_START,
  type LayoutNode,
  NAMED_OPERATOR_END,
  NAMED_OPERATOR_START,
  normalizeOutput,
  PROTECTED_SPACE,
  TRAILING_LAYOUT_MARKER_PATTERN,
} from "./layout";
import {
  ACCENTS,
  BLACKBOARD,
  DISPLAY_LIMIT_SYMBOLS,
  FONT_SWITCH_COMMANDS,
  IGNORED_COMMANDS,
  LIMIT_OPERATORS,
  NAMED_OPERATORS,
  NEGATED_SYMBOLS,
  NEGATIVE_SPACE,
  NEGATIVE_SPACING_COMMANDS,
  PLAIN_WRAPPERS,
  RELATION_COMMANDS,
  SIZE_COMMANDS,
  SPACING_COMMANDS,
  SYMBOLS,
} from "./symbols";

export class LatexParser {
  private readonly source: string;
  private readonly layoutNodes: LayoutNode[];
  private readonly display: boolean;
  private position = 0;
  private supported = true;
  private stackFractions = true;
  private scriptDepth = 0;

  constructor(source: string, layoutNodes: LayoutNode[], display: boolean) {
    this.source = source;
    this.layoutNodes = layoutNodes;
    this.display = display;
  }

  render(): string | undefined {
    const rendered = this.parseSequence();
    if (!this.supported || this.position !== this.source.length) {
      return undefined;
    }
    return normalizeOutput(rendered);
  }

  private parseSequence(endCharacter?: string): string {
    let result = "";
    while (this.position < this.source.length) {
      const character = this.source[this.position]!;
      if (endCharacter && character === endCharacter) {
        this.position++;
        return result;
      }

      if (character === "}") {
        this.supported = false;
        return result;
      }

      if (character === "{") {
        this.position++;
        result += this.parseSequence("}");
        continue;
      }

      if (character === "\\") {
        const command = this.parseCommand();
        if (command === NEGATIVE_SPACE) {
          result = result.trimEnd();
          if (result.endsWith(NAMED_OPERATOR_END)) {
            result = result.slice(0, -NAMED_OPERATOR_END.length);
          }
        } else {
          result += command;
        }
        continue;
      }

      if (character === "^" || character === "_") {
        this.position++;
        result = result.trimEnd();
        const script = this.parseScripts(character);
        if (result.endsWith(NAMED_OPERATOR_END)) {
          result = `${result.slice(0, -NAMED_OPERATOR_END.length)}${script}${NAMED_OPERATOR_END}`;
        } else {
          result += script;
        }
        continue;
      }

      if (/\s/.test(character)) {
        result += this.parseWhitespace();
        continue;
      }

      if (character === "=" || character === "<" || character === ">") {
        result = `${result.trimEnd()} ${character} `;
        this.position++;
        continue;
      }

      if (character === "&") {
        this.position++;
        continue;
      }

      if (character === "~") {
        this.position++;
        result += " ";
        continue;
      }

      if (character === ".") {
        const marker = TRAILING_LAYOUT_MARKER_PATTERN.exec(result);
        const node = marker ? this.layoutNodes[Number(marker[1])] : undefined;
        if (node?.type === "matrix") {
          const lastLine = node.lines.length - 1;
          node.lines[lastLine] = `${node.lines[lastLine] ?? ""}${character}`;
          this.position++;
          continue;
        }
      }

      result += character;
      this.position++;
    }

    if (endCharacter) {
      this.supported = false;
    }
    return result;
  }

  private parseScripts(initialMarker: "^" | "_"): string {
    const scripts: { sub?: string; sup?: string } = {};
    const order: Array<"sub" | "sup"> = [];
    const parse = (marker: "^" | "_"): void => {
      const kind = marker === "_" ? "sub" : "sup";
      this.scriptDepth++;
      try {
        scripts[kind] = this.parseRequiredArgument(false);
      } finally {
        this.scriptDepth--;
      }
      order.push(kind);
    };

    parse(initialMarker);
    let nextPosition = this.position;
    while (nextPosition < this.source.length && /\s/.test(this.source[nextPosition] ?? "")) {
      nextPosition++;
    }
    const nextMarker = this.source[nextPosition];
    if ((nextMarker === "^" || nextMarker === "_") && nextMarker !== initialMarker) {
      this.position = nextPosition + 1;
      parse(nextMarker);
    }

    const subUnicode =
      scripts.sub === undefined ? undefined : formatUnicodeScript(scripts.sub, "sub");
    const supUnicode =
      scripts.sup === undefined ? undefined : formatUnicodeScript(scripts.sup, "sup");
    const canUseLayout = ![scripts.sub, scripts.sup].some(
      (value) =>
        value !== undefined &&
        (value.includes("/") ||
          (!value.includes(LAYOUT_MARKER_START) &&
            Array.from(value).length > 1 &&
            !/[A-Z*∗]/.test(value))),
    );
    const needsLayout =
      this.display &&
      canUseLayout &&
      (this.scriptDepth > 0 ||
        (scripts.sub !== undefined && subUnicode === undefined) ||
        (scripts.sup !== undefined && supUnicode === undefined));
    if (!needsLayout) {
      return order
        .map((kind) =>
          kind === "sub"
            ? (subUnicode ?? formatScript(scripts.sub ?? "", kind))
            : (supUnicode ?? formatScript(scripts.sup ?? "", kind)),
        )
        .join("");
    }

    const index =
      this.layoutNodes.push({
        type: "script",
        lower: scripts.sub === undefined ? undefined : normalizeOutput(scripts.sub),
        upper: scripts.sup === undefined ? undefined : normalizeOutput(scripts.sup),
      }) - 1;
    return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
  }

  private parseWhitespace(): string {
    while (this.position < this.source.length && /\s/.test(this.source[this.position] ?? "")) {
      this.position++;
    }
    return " ";
  }

  private parseCommand(): string {
    this.position++;
    if (this.position >= this.source.length) {
      this.supported = false;
      return "";
    }

    let command = "";
    const first = this.source[this.position] ?? "";
    if (first === "\n" || first === "\r") {
      this.position++;
      if (first === "\r" && this.source[this.position] === "\n") {
        this.position++;
      }
      return " ";
    }
    if (/[A-Za-z]/.test(first)) {
      const start = this.position;
      while (
        this.position < this.source.length &&
        /[A-Za-z]/.test(this.source[this.position] ?? "")
      ) {
        this.position++;
      }
      command = this.source.slice(start, this.position);
    } else {
      command = first;
      this.position++;
    }

    if (command === "\\") {
      return "\n";
    }
    if (SPACING_COMMANDS.has(command)) {
      return " ";
    }
    if (NEGATIVE_SPACING_COMMANDS.has(command)) {
      return NEGATIVE_SPACE;
    }
    if (FONT_SWITCH_COMMANDS.has(command)) {
      while (this.position < this.source.length && /\s/.test(this.source[this.position] ?? "")) {
        this.position++;
      }
      return "";
    }
    if (IGNORED_COMMANDS.has(command)) {
      return "";
    }
    if (
      command === "{" ||
      command === "}" ||
      command === "$" ||
      command === "%" ||
      command === "#" ||
      command === "_" ||
      command === "&"
    ) {
      return command;
    }
    if (command === "|") {
      return "‖";
    }
    if (command === "not") {
      const value = this.parseRequiredArgument(false).trim();
      const negated = NEGATED_SYMBOLS[value];
      if (negated !== undefined) {
        return ` ${negated} `;
      }
      const characters = Array.from(value);
      if (characters.length === 0) {
        this.supported = false;
        return "";
      }
      return ` ${characters[0]}\u0338${characters.slice(1).join("")} `;
    }
    if (LIMIT_OPERATORS.has(command)) {
      return this.parseOperator(command, "bracket", true, true);
    }

    const symbol = SYMBOLS[command];
    if (symbol !== undefined) {
      if (DISPLAY_LIMIT_SYMBOLS.has(command)) {
        return this.parseOperator(symbol, "script", true);
      }
      return command === "cdot" || command === "times" || RELATION_COMMANDS.has(command)
        ? ` ${symbol} `
        : symbol;
    }
    if (NAMED_OPERATORS.has(command)) {
      return `${NAMED_OPERATOR_START}${command}${NAMED_OPERATOR_END}`;
    }
    if (SIZE_COMMANDS.has(command)) {
      return "";
    }
    if (command === "left" || command === "middle" || command === "right") {
      if (this.source[this.position] === ".") {
        this.position++;
      }
      return "";
    }
    if (command === "frac" || command === "dfrac" || command === "tfrac") {
      const shouldStack = this.display && this.stackFractions && command !== "tfrac";
      const numerator = this.parseRequiredArgument(!shouldStack);
      const denominator = this.parseRequiredArgument(!shouldStack);
      if (shouldStack) {
        const index =
          this.layoutNodes.push({
            type: "fraction",
            numerator: normalizeOutput(numerator),
            denominator: normalizeOutput(denominator),
          }) - 1;
        return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
      }
      return formatFraction(numerator, denominator);
    }
    if (command === "sqrt") {
      const degree = this.parseOptionalArgument()?.trim();
      const value = this.parseRequiredArgument();
      if (degree === undefined || degree === "2") {
        return formatRoot(value);
      }
      if (degree === "3") {
        return formatRoot(value, "∛");
      }
      if (degree === "4") {
        return formatRoot(value, "∜");
      }
      return `${formatScript(degree, "sup")}${formatRoot(value)}`;
    }
    if (command === "boxed" || command === "fbox") {
      return `[${this.parseRequiredArgument().trim()}]`;
    }
    if (command === "binom" || command === "dbinom" || command === "tbinom") {
      return `(${this.parseRequiredArgument()} choose ${this.parseRequiredArgument()})`;
    }
    const accent = ACCENTS[command];
    if (accent !== undefined) {
      const value = this.parseRequiredArgument();
      return Array.from(value).length === 1 ? `${value}${accent}` : `${command}(${value})`;
    }
    if (command === "mathbb") {
      const value = this.parseRequiredArgument();
      return Array.from(value, (character) => BLACKBOARD[character] ?? character).join("");
    }
    if (command === "operatorname") {
      const starred = this.source[this.position] === "*";
      if (starred) {
        this.position++;
      }
      const operator = normalizeOutput(this.parseRequiredArgument()).trim();
      return this.parseOperator(operator, "bracket", starred, true);
    }
    if (command === "mod" || command === "bmod") {
      return " mod ";
    }
    if (command === "pmod" || command === "pod") {
      const value = this.parseRequiredArgument().trim();
      return command === "pmod" ? ` (mod ${value})` : ` (${value})`;
    }
    if (command === "overset" || command === "stackrel") {
      const upper = this.parseRequiredArgument();
      const value = this.parseRequiredArgument().trim();
      return `${value}${formatScript(upper, "sup")}`;
    }
    if (command === "underset") {
      const lower = this.parseRequiredArgument();
      const value = this.parseRequiredArgument().trim();
      return `${value}${formatScript(lower, "sub")}`;
    }
    if (PLAIN_WRAPPERS.has(command)) {
      const value = this.parseRequiredArgument();
      return command.startsWith("text") || command === "mbox" ? value : value.trim();
    }
    if (command === "begin") {
      return this.parseEnvironment();
    }
    if (command === "end") {
      this.supported = false;
      return "";
    }

    this.supported = false;
    return `\\${command}`;
  }

  private parseOperator(
    operator: string,
    inlineLowerStyle: "bracket" | "script",
    displayLimits: boolean,
    spaced = false,
  ): string {
    let useDisplayLimits = displayLimits;
    let modifierPosition = this.position;
    while (
      modifierPosition < this.source.length &&
      /[ \t]/.test(this.source[modifierPosition] ?? "")
    ) {
      modifierPosition++;
    }
    const modifier = /^\\(limits|nolimits)(?![A-Za-z])/.exec(this.source.slice(modifierPosition));
    if (modifier) {
      useDisplayLimits = modifier[1] === "limits";
      this.position = modifierPosition + modifier[0].length;
    }

    let lower: string | undefined;
    let upper: string | undefined;
    while (true) {
      let scriptPosition = this.position;
      while (
        scriptPosition < this.source.length &&
        /[ \t]/.test(this.source[scriptPosition] ?? "")
      ) {
        scriptPosition++;
      }
      const kind = this.source[scriptPosition];
      if (kind !== "_" && kind !== "^") {
        break;
      }
      this.position = scriptPosition + 1;
      const value = normalizeOutput(this.parseRequiredArgument(false)).replaceAll(" ", "");
      if (kind === "_") {
        if (lower !== undefined) {
          this.supported = false;
        }
        lower = value;
      } else {
        if (upper !== undefined) {
          this.supported = false;
        }
        upper = value;
      }
    }

    if (this.display && useDisplayLimits && (lower !== undefined || upper !== undefined)) {
      const index = this.layoutNodes.push({ type: "operator", operator, lower, upper }) - 1;
      return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
    }

    let rendered = operator;
    if (lower !== undefined) {
      rendered += inlineLowerStyle === "bracket" ? `[${lower}]` : formatScript(lower, "sub");
    }
    if (upper !== undefined) {
      rendered += formatScript(upper, "sup");
    }
    return spaced ? ` ${rendered} ` : rendered;
  }

  private parseRequiredArgument(stackFractions = true): string {
    const previousStackFractions = this.stackFractions;
    this.stackFractions = previousStackFractions && stackFractions;
    const value = this.parseRequiredArgumentValue();
    this.stackFractions = previousStackFractions;
    return value;
  }

  private parseRequiredArgumentValue(): string {
    while (this.position < this.source.length && /\s/.test(this.source[this.position] ?? "")) {
      this.position++;
    }
    if (this.position >= this.source.length) {
      this.supported = false;
      return "";
    }
    if (this.source[this.position] === "{") {
      this.position++;
      return this.parseSequence("}");
    }
    if (this.source[this.position] === "\\") {
      return this.parseCommand();
    }
    const value = this.source[this.position] ?? "";
    this.position++;
    return value;
  }

  private parseOptionalArgument(): string | undefined {
    while (this.position < this.source.length && /[ \t]/.test(this.source[this.position] ?? "")) {
      this.position++;
    }
    if (this.source[this.position] !== "[") {
      return undefined;
    }
    const end = this.source.indexOf("]", this.position + 1);
    if (end < 0) {
      this.supported = false;
      return undefined;
    }
    const value = this.source.slice(this.position + 1, end);
    this.position = end + 1;
    return this.renderNested(value);
  }

  private readRawGroup(): string | undefined {
    while (this.position < this.source.length && /[ \t]/.test(this.source[this.position] ?? "")) {
      this.position++;
    }
    if (this.source[this.position] !== "{") {
      this.supported = false;
      return undefined;
    }

    const start = ++this.position;
    let depth = 1;
    while (this.position < this.source.length) {
      const character = this.source[this.position];
      if (character === "\\") {
        this.position += 2;
        continue;
      }
      if (character === "{") depth++;
      if (character === "}") depth--;
      if (depth === 0) {
        const value = this.source.slice(start, this.position);
        this.position++;
        return value;
      }
      this.position++;
    }
    this.supported = false;
    return undefined;
  }

  private splitEnvironmentRows(body: string): string[] {
    return body.split(/\\\\(?:\[[^\]\n]*\])?/);
  }

  private parseEnvironment(): string {
    const environment = this.readRawGroup();
    if (!environment) {
      return "";
    }
    const endMarker = `\\end{${environment}}`;
    const end = this.source.indexOf(endMarker, this.position);
    if (end < 0) {
      this.supported = false;
      return "";
    }
    const body = this.source.slice(this.position, end);
    this.position = end + endMarker.length;

    if (
      environment === "equation" ||
      environment === "equation*" ||
      environment === "displaymath"
    ) {
      return this.renderNested(body).trim();
    }

    if (
      environment === "aligned" ||
      environment === "align" ||
      environment === "align*" ||
      environment === "alignedat" ||
      environment === "alignat" ||
      environment === "alignat*" ||
      environment === "gather" ||
      environment === "gathered" ||
      environment === "multline" ||
      environment === "multline*" ||
      environment === "split"
    ) {
      const alignedAt = ["alignedat", "alignat", "alignat*"].includes(environment);
      const alignedBody = alignedAt ? body.replace(/^\s*\{[^}]*\}/, "") : body;
      return this.splitEnvironmentRows(alignedBody)
        .map((row) => {
          const cells = row.split("&");
          const source = alignedAt
            ? Array.from({ length: Math.ceil(cells.length / 2) }, (_, index) =>
                cells.slice(index * 2, index * 2 + 2).join(""),
              ).join(" ")
            : cells.join("");
          return this.renderNested(source).trim();
        })
        .filter(Boolean)
        .join("\n");
    }

    if (environment === "cases" || environment === "cases*") {
      return this.renderCases(body);
    }

    if (
      [
        "array",
        "matrix",
        "smallmatrix",
        "pmatrix",
        "bmatrix",
        "Bmatrix",
        "vmatrix",
        "Vmatrix",
      ].includes(environment)
    ) {
      const matrixBody = environment === "array" ? body.replace(/^\s*\{[^}]*\}/, "") : body;
      return this.renderMatrix(environment, matrixBody);
    }

    this.supported = false;
    return body;
  }

  private renderCases(body: string): string {
    const rows = this.splitEnvironmentRows(body)
      .map((row) => row.split("&").map((cell) => this.renderNested(cell, false).trim()))
      .filter((row) => row.some(Boolean));
    const valueWidth = Math.max(
      0,
      ...rows.map((row) => visibleWidth((row[0] ?? "").replace(/,\s*$/, ""))),
    );
    const contents = rows.map((row) => {
      const value = (row[0] ?? "").replace(/,\s*$/, "");
      const condition = row[1] ?? "";
      if (!condition) {
        return value;
      }
      const conditionPrefix = /^(?:if|when|for|otherwise)\b/i.test(condition) ? " " : " if ";
      return `${value}${PROTECTED_SPACE.repeat(valueWidth - visibleWidth(value))}${conditionPrefix}${condition}`;
    });
    if (contents.length <= 1) {
      return contents.length === 0 ? "" : `⎧ ${contents[0]}`;
    }

    const middle = Math.floor(contents.length / 2);
    const visualRows: Array<string | undefined> = [...contents];
    if (contents.length % 2 === 0) {
      visualRows.splice(middle, 0, undefined);
    }
    const lines = visualRows.map((content, index) => {
      const delimiter = index === 0 ? "⎧" : index === visualRows.length - 1 ? "⎩" : "⎨";
      return content === undefined ? delimiter : `${delimiter} ${content}`;
    });
    const index = this.layoutNodes.push({ type: "matrix", lines, baseline: middle }) - 1;
    return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
  }

  private renderMatrix(environment: string, body: string): string {
    const matrix = this.splitEnvironmentRows(body)
      .map((row) => row.split("&").map((cell) => this.renderNested(cell, false).trim()))
      .filter((row) => row.some(Boolean));
    const columnCount = Math.max(0, ...matrix.map((row) => row.length));
    const columnWidths = Array.from({ length: columnCount }, (_, column) =>
      Math.max(0, ...matrix.map((row) => visibleWidth(row[column] ?? ""))),
    );
    const rows = matrix.map((row) =>
      Array.from({ length: columnCount }, (_, column) => {
        const cell = row[column] ?? "";
        return `${cell}${PROTECTED_SPACE.repeat(Math.max(0, (columnWidths[column] ?? 0) - visibleWidth(cell)))}`;
      }).join(" │ "),
    );

    let lines: string[];
    if (environment === "array" || environment === "matrix" || environment === "smallmatrix") {
      lines = rows;
    } else {
      const delimiters: Readonly<
        Record<string, readonly [string, string, string, string, string, string]>
      > = {
        pmatrix: ["⎛", "⎞", "⎜", "⎟", "⎝", "⎠"],
        bmatrix: ["⎡", "⎤", "⎢", "⎥", "⎣", "⎦"],
        Bmatrix: ["⎧", "⎫", "⎨", "⎬", "⎩", "⎭"],
        vmatrix: ["│", "│", "│", "│", "│", "│"],
        Vmatrix: ["║", "║", "║", "║", "║", "║"],
      };
      const delimiter = delimiters[environment];
      if (!delimiter) {
        this.supported = false;
        return rows.join("\n");
      }
      lines = rows.map((row, index) => {
        const left =
          index === 0 ? delimiter[0] : index === rows.length - 1 ? delimiter[4] : delimiter[2];
        const right =
          index === 0 ? delimiter[1] : index === rows.length - 1 ? delimiter[5] : delimiter[3];
        return `${left} ${row} ${right}`;
      });
    }

    if (lines.length <= 1) {
      return lines[0] ?? "";
    }
    const index = this.layoutNodes.push({ type: "matrix", lines, baseline: 0 }) - 1;
    return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
  }

  private renderNested(source: string, stackFractions = true): string {
    const rendered = new LatexParser(
      source,
      this.layoutNodes,
      this.display && stackFractions,
    ).render();
    if (rendered === undefined) {
      this.supported = false;
      return source;
    }
    return rendered;
  }
}
