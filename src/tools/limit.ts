export function clampLimit(limit: number, max: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}
