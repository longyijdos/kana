import { describe, expect, test } from "bun:test";
import { renderLatex } from "../../src/tui/render";

describe("terminal LaTeX renderer", () => {
  test("renders common symbols, blackboard letters, and scripts", () => {
    expect(renderLatex(String.raw`\mathbb{C}^3 \to \mathbb{C}^3`)).toBe("ℂ³ → ℂ³");
    expect(renderLatex(String.raw`\sum_{i=0}^n \alpha_i + x_{k+1}`)).toBe("∑ᵢ₌₀ⁿ αᵢ + xₖ₊₁");
  });

  test("renders compact inline fractions and roots", () => {
    expect(renderLatex(String.raw`\frac{1}{4x^2} + \sqrt[3]{y}`)).toBe("1/(4x²) + ∛y");
  });

  test("stacks display fractions without recursively stacking nested fractions", () => {
    expect(renderLatex(String.raw`\frac{x^2+1}{x-1}`, { display: true })).toBe("x²+1\n────\nx-1");
    expect(renderLatex(String.raw`\frac{\frac{a}{b}}{\frac{c}{d}}`, { display: true })).toBe(
      "a/b\n───\nc/d",
    );
  });

  test("aligns matrix columns and renders cases", () => {
    expect(renderLatex(String.raw`\begin{pmatrix}1&200\\3000&4\end{pmatrix}`)).toBe(
      "⎛ 1    │ 200 ⎞\n⎝ 3000 │ 4   ⎠",
    );
    expect(renderLatex(String.raw`\begin{cases}a & x<0 \\ b & \text{otherwise}\end{cases}`)).toBe(
      "⎧ a if x < 0\n⎩ b otherwise",
    );
  });

  test("stacks operator limits only in display mode", () => {
    const source = String.raw`\sum_{i=0}^n x_i`;

    expect(renderLatex(source)).toBe("∑ᵢ₌₀ⁿ xᵢ");
    expect(renderLatex(source, { display: true })).toBe(" n\n ∑  xᵢ\ni=0");
  });

  test("returns undefined for unsupported or malformed input", () => {
    expect(renderLatex(String.raw`x + \unknown{y}`)).toBeUndefined();
    expect(renderLatex(String.raw`\frac{1}{x`)).toBeUndefined();
    expect(renderLatex(String.raw`\begin{matrix}1 & 2`)).toBeUndefined();
  });
});
