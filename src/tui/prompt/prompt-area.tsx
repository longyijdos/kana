import React from "react";
import type { RunStatus } from "../types";
import { StatusLine } from "../status/status-line";
import { CommandPalette } from "./command-palette";
import { PromptInput } from "./prompt-input";
import type { PromptSubmit } from "./commands";
import { usePromptEditor } from "./use-prompt-editor";

export function PromptArea({
  value,
  status,
  model,
  isRunning,
  onChange,
  onSubmit,
}: {
  value: string;
  status: RunStatus;
  model: string;
  isRunning: boolean;
  onChange(value: string): void;
  onSubmit(submit: PromptSubmit): void;
}) {
  const editor = usePromptEditor({
    value,
    isActive: !isRunning,
    onChange,
    onSubmit,
  });

  return (
    <>
      <PromptInput
        value={value}
        cursorOffset={editor.cursorOffset}
        isRunning={isRunning}
      />

      {editor.commandState.showPalette ? (
        <CommandPalette
          commands={editor.commandState.suggestions}
          selectedIndex={editor.selectedCommandIndex}
        />
      ) : (
        <StatusLine status={status} model={model} isRunning={isRunning} />
      )}
    </>
  );
}
