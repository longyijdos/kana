import React from "react";
import type { LogLine } from "../types";

export function appendLine(
  nextId: React.MutableRefObject<number>,
  setLines: React.Dispatch<React.SetStateAction<LogLine[]>>,
  tone: LogLine["tone"],
  text: string,
): void {
  setLines((current) => [
    ...current,
    {
      id: nextId.current++,
      tone,
      text,
    },
  ]);
}

export function appendToLastLine(
  setLines: React.Dispatch<React.SetStateAction<LogLine[]>>,
  tone: LogLine["tone"],
  delta: string,
): void {
  setLines((current) => {
    const last = current.at(-1);

    if (!last || last.tone !== tone) {
      return current;
    }

    return [
      ...current.slice(0, -1),
      {
        ...last,
        text: last.text + delta,
      },
    ];
  });
}
