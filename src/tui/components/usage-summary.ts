import type { KanaUsageSummary } from "@/kana";
import { color, visibleWidth } from "../render";
import type { Component } from "../runtime";
import { tuiTheme } from "../theme";

export class UsageSummaryBlock implements Component {
  constructor(private readonly summary: KanaUsageSummary) {}

  render(width: number, _availableHeight?: number): string[] {
    const usage = this.summary.usage;
    const cached = usage?.promptCacheHitTokens ?? 0;
    const input = usage?.promptCacheMissTokens ?? Math.max(0, (usage?.promptTokens ?? 0) - cached);
    const output = usage?.completionTokens ?? 0;
    const tokenValues = [
      input,
      cached,
      output,
      ...(usage?.reasoningTokens ? [usage.reasoningTokens] : []),
    ];
    const valueWidth = Math.max(
      10,
      ...tokenValues.map((value) => visibleWidth(formatInteger(value))),
    );
    const total = Math.max(1, input + cached + output);
    const barWidth = Math.max(6, Math.min(18, width - 9 - valueWidth - 2));
    const line = (label: string, value: number, tone: Parameters<typeof color>[1]) =>
      `${label.padEnd(9)}${formatInteger(value).padStart(valueWidth)}  ${color(bar(value, total, barWidth), tone)}`;
    const agentRows = [
      {
        label: "Main",
        runCount: this.summary.agents.main.runCount,
        tokenCount: this.summary.agents.main.usage?.totalTokens ?? 0,
        tone: tuiTheme.usageInput,
      },
      {
        label: "Memory auto",
        runCount: this.summary.agents.memoryAutomatic.runCount,
        tokenCount: this.summary.agents.memoryAutomatic.usage?.totalTokens ?? 0,
        tone: tuiTheme.usageCache,
      },
      {
        label: "Memory manual",
        runCount: this.summary.agents.memoryManual.runCount,
        tokenCount: this.summary.agents.memoryManual.usage?.totalTokens ?? 0,
        tone: tuiTheme.usageReasoning,
      },
    ];
    const runCountWidth = Math.max(1, ...agentRows.map((row) => String(row.runCount).length));
    const runTokenCountWidth = Math.max(
      1,
      ...agentRows.map((row) => visibleWidth(formatInteger(row.tokenCount))),
    );
    const modelRows = this.summary.models.map((model) => ({
      label: `${model.provider}/${model.model}`,
      runCount: model.runCount,
      tokenCount: model.usage?.totalTokens ?? 0,
    }));
    const modelLabelWidth = Math.max(0, ...modelRows.map((row) => visibleWidth(row.label)));
    const modelRunCountWidth = Math.max(1, ...modelRows.map((row) => String(row.runCount).length));
    const modelTokenCountWidth = Math.max(
      1,
      ...modelRows.map((row) => visibleWidth(formatInteger(row.tokenCount))),
    );

    return [
      color("Tokens", tuiTheme.markdownHeading),
      line("Input", input, tuiTheme.usageInput),
      line("Cached", cached, tuiTheme.usageCache),
      line("Output", output, tuiTheme.usageOutput),
      usage?.reasoningTokens
        ? line("Reasoning", usage.reasoningTokens, tuiTheme.usageReasoning)
        : undefined,
      "",
      color("Runs", tuiTheme.markdownHeading),
      ...agentRows.map((row) =>
        runLine(
          row.label,
          row.runCount,
          row.tokenCount,
          row.tone,
          runCountWidth,
          runTokenCountWidth,
        ),
      ),
      "",
      `${color("Completed", tuiTheme.usageOutput)} ${this.summary.outcomes.stop}  ${color("Output limit", tuiTheme.usageWarning)} ${this.summary.outcomes.length}  ${color("Turn limit", tuiTheme.usageWarning)} ${this.summary.outcomes.turn_limit}  ${color("Aborted", tuiTheme.usageWarning)} ${this.summary.outcomes.aborted}  ${color("Failed", tuiTheme.error)} ${this.summary.outcomes.error}`,
      ...modelRows.map((row) =>
        color(
          modelLine(
            row.label,
            row.runCount,
            row.tokenCount,
            modelLabelWidth,
            modelRunCountWidth,
            modelTokenCountWidth,
          ),
          tuiTheme.usageMuted,
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
  tokens: number,
  tone: Parameters<typeof color>[1],
  countWidth: number,
  tokenCountWidth: number,
): string {
  return `${color(label.padEnd(14), tone)}${String(count).padStart(countWidth)}  ${formatInteger(tokens).padStart(tokenCountWidth)} tokens`;
}
function modelLine(
  label: string,
  count: number,
  tokens: number,
  labelWidth: number,
  countWidth: number,
  tokenCountWidth: number,
): string {
  return `${label.padEnd(labelWidth)}  ${String(count).padStart(countWidth)} runs  ${formatInteger(tokens).padStart(tokenCountWidth)} tokens`;
}
function bar(value: number, total: number, width: number): string {
  const filled = Math.round((value / total) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}
function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}
