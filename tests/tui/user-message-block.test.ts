import { describe, expect, test } from "bun:test";
import { UserMessageBlock } from "../../src/tui/components";
import { stripAnsi, visibleWidth } from "../../src/tui/render";
import { tuiTheme } from "../../src/tui/theme";
import { messageIdentityForTest } from "../helpers/messages";

describe("tui user message block", () => {
  test("renders neutral text with an accent prefix inside an ASCII frame", () => {
    const rendered = new UserMessageBlock("hello\nworld").render(20);
    const accent = `\x1b[38;2;${tuiTheme.user.join(";")}m`;
    const text = `\x1b[38;2;${tuiTheme.userMessageText.join(";")}m`;

    expect(rendered.map(stripAnsi)).toEqual([
      "+------------------+",
      "| > hello          |",
      "|   world          |",
      "+------------------+",
    ]);
    expect(rendered.join("\n")).not.toContain("\x1b[48;");
    expect(rendered.join("\n")).not.toContain("\x1b[K");
    expect(rendered[1]).toContain(`${accent}> ${text}hello`);
  });

  test("wraps content inside the prefix and frame", () => {
    const rendered = new UserMessageBlock("abcdef").render(8);

    expect(rendered.map(stripAnsi)).toEqual([
      "+------+",
      "| > ab |",
      "|   cd |",
      "|   ef |",
      "+------+",
    ]);
    expect(rendered.every((line) => visibleWidth(line) <= 8)).toBe(true);
  });

  test("renders image attachment metadata without exposing encoded bytes", () => {
    const rendered = new UserMessageBlock({
      ...messageIdentityForTest("user"),
      role: "user",
      content: "",
      images: [
        {
          mimeType: "image/png",
          data: "eA==",
          width: 32,
          height: 16,
        },
      ],
    }).render(48);
    const plain = rendered.map(stripAnsi);

    expect(plain).toContainEqual(expect.stringContaining("[Image 1 · PNG · 32×16 · 1 KB]"));
    expect(rendered.join("\n")).not.toContain("eA==");
  });
});
