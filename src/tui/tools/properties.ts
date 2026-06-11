export function getStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }

  const property = value[key as keyof typeof value];

  return typeof property === "string" ? property : undefined;
}

export function getNumberProperty(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }

  const property = value[key as keyof typeof value];

  return typeof property === "number" ? property : undefined;
}
