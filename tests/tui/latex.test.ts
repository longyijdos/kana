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
      "⎧ a if x < 0\n⎨\n⎩ b otherwise",
    );
    expect(
      renderLatex(
        String.raw`f(x)=\begin{cases}a & x<0 \\ b & \text{if }x=0 \\ c & \text{otherwise}\end{cases}`,
      ),
    ).toBe("       ⎧ a if x < 0\nf(x) = ⎨ b if x = 0\n       ⎩ c otherwise");
  });

  test("renders relational algebra join symbols", () => {
    expect(renderLatex(String.raw`R \bowtie S \quad R \Join S`)).toBe("R ⋈ S R ⋈ S");
    expect(renderLatex(String.raw`R \ltimes S \quad R \rtimes S`)).toBe("R ⋉ S R ⋊ S");
    expect(
      renderLatex(
        String.raw`R \leftouterjoin S \quad R \rightouterjoin S \quad R \fullouterjoin S`,
      ),
    ).toBe("R ⟕ S R ⟖ S R ⟗ S");
  });

  test("supports font switch commands", () => {
    expect(
      renderLatex(
        String.raw`\textnormal{hello}+{\rm roman}+{\bf bold}+{\it italic}+{\sf sans}+{\tt mono}+{\cal calligraphic}+{\sl slanted}`,
      ),
    ).toBe("hello+roman+bold+italic+sans+mono+calligraphic+slanted");
  });

  test("lays out complex and nested scripts in display mode", () => {
    expect(
      renderLatex(String.raw`\partial_tU_2(t,0)=Aj_*(1-t)^{-A-1}.\qquad x^{n^2}+x_{i_j}`, {
        display: true,
      }),
    ).toBe(
      "                            2\n                    -A-1   n\n∂ₜU₂(t,0) = Aj (1-t)    . x  +x\n              *                i\n                                j",
    );
    expect(renderLatex(String.raw`e^{\frac{1}{2}}+\tfrac{1}{2}`, { display: true })).toBe(
      "e^(1/2)+1/2",
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
