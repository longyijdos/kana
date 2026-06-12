export type KanaEnvironmentContext = {
  cwd: string;
  platform: NodeJS.Platform;
  currentDate: string;
  timezone: string;
};

export type CollectKanaEnvironmentContextOptions = {
  cwd?: string;
  now?: Date;
  platform?: NodeJS.Platform;
  timezone?: string;
};

export function collectKanaEnvironmentContext(
  options: CollectKanaEnvironmentContextOptions = {},
): KanaEnvironmentContext {
  const timezone = options.timezone ?? getLocalTimezone();

  return {
    cwd: options.cwd ?? process.cwd(),
    platform: options.platform ?? process.platform,
    currentDate: formatDateInTimezone(options.now ?? new Date(), timezone),
    timezone,
  };
}

export function formatKanaEnvironmentContext(
  context: KanaEnvironmentContext,
): string {
  return [
    "<environment_context>",
    `  <cwd>${context.cwd}</cwd>`,
    `  <platform>${context.platform}</platform>`,
    `  <current_date>${context.currentDate}</current_date>`,
    `  <timezone>${context.timezone}</timezone>`,
    "</environment_context>",
  ].join("\n");
}

function getLocalTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
}

function formatDateInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = getDatePart(parts, "year");
  const month = getDatePart(parts, "month");
  const day = getDatePart(parts, "day");

  return `${year}-${month}-${day}`;
}

function getDatePart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  const part = parts.find((candidate) => candidate.type === type);

  if (!part) {
    throw new Error(`Missing date part: ${type}`);
  }

  return part.value;
}
