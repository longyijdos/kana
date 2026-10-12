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

import { type LayoutNode, PROTECTED_SPACE, renderLayout } from "./layout";
import { LatexParser } from "./parser";

export interface RenderLatexOptions {
  /** Stack fractions and operator limits vertically for display math (default: false). */
  display?: boolean;
}

/**
 * Render a basic LaTeX math expression as terminal-friendly Unicode text.
 * Returns undefined when the expression contains unsupported or malformed syntax.
 */
export function renderLatex(source: string, options: RenderLatexOptions = {}): string | undefined {
  const layoutNodes: LayoutNode[] = [];
  const rendered = new LatexParser(source, layoutNodes, options.display === true).render();
  if (rendered === undefined) {
    return undefined;
  }
  if (layoutNodes.length === 0) {
    return rendered.replaceAll(PROTECTED_SPACE, " ");
  }
  const lines = renderLayout(rendered, layoutNodes).lines;
  const indentation = Math.min(
    ...lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length),
  );
  return lines
    .map((line) => line.slice(indentation).trimEnd())
    .join("\n")
    .trimEnd()
    .replaceAll(PROTECTED_SPACE, " ");
}
