export function summarizeText(value: string, maxLength = 80): string {
  const normalized = value.trim().replace(/\s+/g, " ");

  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...`
    : normalized;
}

export function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}
