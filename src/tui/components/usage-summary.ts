import type { KanaUsageSummary } from "@/kana";
import { color, visibleWidth } from "../render";
import type { Component } from "../runtime";
import { tuiTheme } from "../theme";

export class UsageSummaryBlock implements Component {
  constructor(private readonly summary: KanaUsageSummary) {}

  render(width: number): string[] {
    const usage = this.summary.usage;
    const cached = usage?.promptCacheHitTokens ?? 0;
    const input = usage?.promptCacheMissTokens ?? Math.max(0, (usage?.promptTokens ?? 0) - cached);
    const output = usage?.completionTokens ?? 0;
    const total = Math.max(1, input + cached + output);
    const barWidth = Math.max(6, Math.min(18, width - 30));
    const line = (label: string, value: number, tone: Parameters<typeof color>[1]) =>
      `${label.padEnd(9)}${formatInteger(value).padStart(10)}  ${color(bar(value, total, barWidth), tone)}`;

    return [
      color(`Usage · ${this.summary.scope}`, tuiTheme.welcomeTitle),
      `${color("Cost", tuiTheme.muted).padEnd(12)}${color(formatCny(this.summary.costCny), tuiTheme.prompt)}`,
      "",
      color("Tokens", tuiTheme.markdownHeading),
      line("Input", input, tuiTheme.model),
      line("Cached", cached, tuiTheme.contextUsage),
      line("Output", output, tuiTheme.toolSuccess),
      usage?.reasoningTokens
        ? line("Reasoning", usage.reasoningTokens, tuiTheme.shortcutHint)
        : undefined,
      "",
      color("Runs", tuiTheme.markdownHeading),
      runLine(
        "Main",
        this.summary.agents.main.runCount,
        this.summary.agents.main.costCny,
        tuiTheme.model,
      ),
      runLine(
        "Memory auto",
        this.summary.agents.memoryAutomatic.runCount,
        this.summary.agents.memoryAutomatic.costCny,
        tuiTheme.contextUsage,
      ),
      runLine(
        "Memory manual",
        this.summary.agents.memoryManual.runCount,
        this.summary.agents.memoryManual.costCny,
        tuiTheme.shortcutHint,
      ),
      "",
      `${color("Completed", tuiTheme.toolSuccess)} ${this.summary.outcomes.stop}  ${color("Output limit", tuiTheme.prompt)} ${this.summary.outcomes.length}  ${color("Aborted", tuiTheme.toolActive)} ${this.summary.outcomes.aborted}  ${color("Failed", tuiTheme.error)} ${this.summary.outcomes.error}`,
      ...this.summary.models.map((model) =>
        color(
          `${model.provider}/${model.model}  ${model.runCount} runs  ${formatCny(model.costCny)}`,
          tuiTheme.muted,
        ),
      ),
    ]
      .filter((value): value is string => value !== undefined)
      .map((value) => (visibleWidth(value) > width ? value.slice(0, width) : value));
  }
}

function runLine(
  label: string,
  count: number,
  cost: number,
  tone: Parameters<typeof color>[1],
): string {
  return `${color(label.padEnd(14), tone)}${String(count).padStart(3)}  ${formatCny(cost)}`;
}
function bar(value: number, total: number, width: number): string {
  const filled = Math.round((value / total) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}
function formatCny(value: number): string {
  return `¥${value.toFixed(4)}`;
}
function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}
