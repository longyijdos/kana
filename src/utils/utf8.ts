// Slice by UTF-8 byte budget without splitting a code point.
export function sliceUtf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let length = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > maxBytes) break;
    length += character.length;
  }
  return text.slice(0, length);
}

export function sliceUtf8Suffix(text: string, maxBytes: number): string {
  const characters = Array.from(text);
  let bytes = 0;
  let start = characters.length;
  while (start > 0) {
    bytes += Buffer.byteLength(characters[start - 1]!, "utf8");
    if (bytes > maxBytes) break;
    start -= 1;
  }
  return characters.slice(start).join("");
}
