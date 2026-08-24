type KanaTodoStatus = "pending" | "in_progress" | "completed";

export type KanaTodoItem = {
  content: string;
  status: KanaTodoStatus;
};

export type KanaTodoStateChange = {
  toolCallId: string;
  items: KanaTodoItem[];
};

export type KanaTodoCounts = Record<KanaTodoStatus, number>;

export function normalizeKanaTodoItems(items: readonly KanaTodoItem[]): KanaTodoItem[] {
  const normalized: KanaTodoItem[] = [];
  const contents = new Set<string>();
  let activeCount = 0;

  for (const item of items) {
    const content = item.content.trim();
    if (!content) {
      throw new Error("Todo item content cannot be blank.");
    }
    if (contents.has(content)) {
      throw new Error(`Duplicate todo item content: ${content}`);
    }
    contents.add(content);
    activeCount += item.status === "in_progress" ? 1 : 0;
    normalized.push({ content, status: item.status });
  }

  if (activeCount > 1) {
    throw new Error("A todo list can contain at most one in_progress item.");
  }

  return normalized;
}

export function isKanaTodoItems(value: unknown): value is KanaTodoItem[] {
  if (!Array.isArray(value) || !value.every(isKanaTodoItem)) {
    return false;
  }

  try {
    const normalized = normalizeKanaTodoItems(value as KanaTodoItem[]);
    return normalized.every(
      (item, index) =>
        item.content === value[index]?.content &&
        item.status === value[index]?.status &&
        hasOnlyTodoItemFields(value[index]),
    );
  } catch {
    return false;
  }
}

export function countKanaTodos(items: readonly KanaTodoItem[]): KanaTodoCounts {
  const counts: KanaTodoCounts = {
    pending: 0,
    in_progress: 0,
    completed: 0,
  };

  for (const item of items) {
    counts[item.status] += 1;
  }

  return counts;
}

export function formatKanaTodoWriteAcknowledgement(items: readonly KanaTodoItem[]): string {
  return items.length === 0 ? "Todo list cleared." : "Todo list updated.";
}

function hasOnlyTodoItemFields(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const keys = Object.keys(value);
  return keys.length === 2 && keys.includes("content") && keys.includes("status");
}

function isKanaTodoItem(value: unknown): value is KanaTodoItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const item = value as Record<string, unknown>;
  return (
    typeof item.content === "string" &&
    (item.status === "pending" || item.status === "in_progress" || item.status === "completed") &&
    hasOnlyTodoItemFields(item)
  );
}
