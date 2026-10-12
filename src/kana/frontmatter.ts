export type FrontmatterFields = Readonly<Record<string, string | readonly string[]>>;

export type Frontmatter = {
  readonly fields: FrontmatterFields;
  readonly body: string;
};

// Reads the leading `---` block of a Markdown file. Values are `key: value`
// scalars (optionally quoted), `|` or `>` indented blocks, or `- item` lists.
// Returns undefined when the file has no frontmatter.
export function readFrontmatter(content: string): Frontmatter | undefined {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return undefined;
  }
  const delimitedEnd = normalized.indexOf("\n---\n", 3);
  const end =
    delimitedEnd >= 0 ? delimitedEnd : normalized.endsWith("\n---") ? normalized.length - 4 : -1;
  if (end < 0) {
    throw new Error("frontmatter is missing a closing --- marker");
  }
  return { fields: parseFields(normalized.slice(4, end)), body: normalized.slice(end + 4) };
}

// Names of Markdown-defined resources such as subagent profiles and prompt
// templates, taken from their file names.
export function isKanaResourceName(name: string): boolean {
  return name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

export function unquote(value: string): string {
  const match = /^(?:"(.*)"|'(.*)')$/.exec(value);
  return match ? (match[1] ?? match[2] ?? "") : value;
}

function parseFields(block: string): FrontmatterFields {
  const fields: Record<string, string | readonly string[]> = {};
  const lines = block.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (!match) {
      throw new Error(`invalid frontmatter line: ${line}`);
    }
    const key = match[1] ?? "";
    const value = (match[2] ?? "").trim();
    if (Object.hasOwn(fields, key)) {
      throw new Error(`${key} is declared more than once`);
    }

    const continuation: string[] = [];
    while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1] ?? "")) {
      index += 1;
      continuation.push(lines[index] ?? "");
    }

    if (value === "|" || value === ">") {
      fields[key] = continuation.map((item) => item.replace(/^ {2}/, "")).join("\n");
    } else if (value === "" && continuation.length > 0) {
      fields[key] = continuation.map((item) => {
        const listItem = /^\s+-\s+(.*)$/.exec(item);
        if (!listItem) throw new Error(`invalid frontmatter line: ${item}`);
        return unquote((listItem[1] ?? "").trim());
      });
    } else if (continuation.length > 0) {
      throw new Error(`invalid frontmatter line: ${continuation[0]}`);
    } else {
      fields[key] = unquote(value);
    }
  }
  return fields;
}
