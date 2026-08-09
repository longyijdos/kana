import { expect, test } from "bun:test";
import {
  createRandomPromptPlaceholder,
  PROMPT_COMMANDS,
  PROMPT_SHORTCUTS,
} from "../../src/tui/components/editor/commands";
import { visibleWidth } from "../../src/tui/render";

const MAX_DEFAULT_PLACEHOLDER_WIDTH = 74; // 80 columns minus "| ", "> ", and " |".

test("prompt placeholders fit the default editor width", () => {
  const placeholderCount = PROMPT_COMMANDS.length + PROMPT_SHORTCUTS.length;

  for (let index = 0; index < placeholderCount; index += 1) {
    const placeholder = createRandomPromptPlaceholder(() => index / placeholderCount);

    expect(visibleWidth(placeholder)).toBeLessThanOrEqual(MAX_DEFAULT_PLACEHOLDER_WIDTH);
  }
});
