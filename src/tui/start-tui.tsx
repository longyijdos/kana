import React from "react";
import { render } from "ink";
import { createKanaAgent } from "../kana/agent";
import { App } from "./app";

export type StartTuiOptions = {
  apiKey?: string;
};

export function startTui(options: StartTuiOptions = {}): void {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    throw new Error(
      "Missing DEEPSEEK_API_KEY. Run with: DEEPSEEK_API_KEY=... ./kana",
    );
  }

  render(<App agent={createKanaAgent(apiKey)} />, {
    alternateScreen: true,
  });
}
