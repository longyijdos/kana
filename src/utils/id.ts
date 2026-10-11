// Kana IDs are `<kind>_<uuid>`; the first eight characters after the kind
// prefix are enough to tell items apart in labels.
export function shortId(id: string): string {
  return id.replace(/^(?:agent|job|task)_/, "").slice(0, 8);
}
