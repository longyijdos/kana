type KanaTodoStatus = "pending" | "in_progress" | "completed";

export type KanaTodoItem = {
  readonly content: string;
  readonly status: KanaTodoStatus;
};

export type KanaTodoStateChange = {
  readonly toolCallId: string;
  readonly parentToolCallId?: string;
  readonly items: readonly KanaTodoItem[];
};

export type KanaTodoCounts = Record<KanaTodoStatus, number>;

export function normalizeKanaTodoItems(items: readonly KanaTodoItem[]): readonly KanaTodoItem[] {
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
