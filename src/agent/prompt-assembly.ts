import { createUserMessage, type Message, type UserMessage } from "@/core";
import type { Tool } from "@/tools";

type MaybePromise<T> = Promise<T> | T;
type RuntimeContextMessage = UserMessage & {
  provenance: Extract<UserMessage["provenance"], { kind: "runtime_context" }>;
};

export type PromptAssemblyContext = {
  signal: AbortSignal;
};

export type PromptSystemSection = {
  name: string;
  content: string;
};

export type PromptContextSection = {
  name: string;
  render(context: PromptAssemblyContext): MaybePromise<string | undefined>;
};

export type PromptToolSection = {
  name: string;
  // The initial snapshot keeps Agent.state useful before the first model step;
  // resolve reads capability-owned mutable state at later step boundaries.
  tools: readonly Tool[];
  resolve?(context: PromptAssemblyContext): MaybePromise<readonly Tool[]>;
};

export type PromptAssemblyOptions = {
  system?: readonly PromptSystemSection[];
  context?: readonly PromptContextSection[];
  tools?: readonly PromptToolSection[];
};

export type PromptContextSnapshot = {
  source: string;
  content: string;
};

export type AssembledPrompt = {
  system?: string;
  context: PromptContextSnapshot[];
  tools: Tool[];
};

export class PromptAssembly {
  readonly systemSections: readonly PromptSystemSection[];
  readonly contextSections: readonly PromptContextSection[];
  readonly toolSections: readonly PromptToolSection[];
  readonly initialSystem?: string;
  readonly initialTools: readonly Tool[];

  constructor(options: PromptAssemblyOptions = {}) {
    this.systemSections = Object.freeze(
      (options.system ?? []).map((section) => Object.freeze({ ...section })),
    );
    this.contextSections = Object.freeze(
      (options.context ?? []).map((section) => Object.freeze({ ...section })),
    );
    this.toolSections = Object.freeze(
      (options.tools ?? []).map((section) =>
        Object.freeze({
          ...section,
          tools: Object.freeze(section.tools.slice()),
        }),
      ),
    );

    assertUniqueSectionNames(this.systemSections, "system");
    assertUniqueSectionNames(this.contextSections, "context");
    assertUniqueSectionNames(this.toolSections, "tool");
    this.initialSystem = formatSystemSections(this.systemSections);
    this.initialTools = Object.freeze(this.toolSections.flatMap((section) => section.tools));
    assertUniqueToolNames(this.initialTools);
    Object.freeze(this);
  }

  async assemble(context: PromptAssemblyContext): Promise<AssembledPrompt> {
    throwIfAborted(context.signal);

    const snapshots: PromptContextSnapshot[] = [];
    for (const section of this.contextSections) {
      const content = await section.render(context);
      throwIfAborted(context.signal);
      if (content !== undefined) {
        snapshots.push({ source: section.name, content: content.trimEnd() });
      }
    }

    const tools: Tool[] = [];
    for (const section of this.toolSections) {
      const resolved = section.resolve ? await section.resolve(context) : section.tools;
      throwIfAborted(context.signal);
      tools.push(...resolved);
    }
    assertUniqueToolNames(tools);

    return {
      system: this.initialSystem,
      context: snapshots,
      tools,
    };
  }
}

export function createPromptAssembly(options: PromptAssemblyOptions = {}): PromptAssembly {
  return new PromptAssembly(options);
}

export function createRuntimeContextMessage(snapshot: PromptContextSnapshot): UserMessage {
  return createUserMessage({
    provenance: { kind: "runtime_context", source: snapshot.source },
    content: formatRuntimeContextMessageContent(snapshot),
  });
}

export function createRuntimeContextRemovalMessage(source: string): UserMessage {
  // Persist disappearance as a state transition so replay cannot revive the
  // preceding snapshot. Projection recognizes this marker but never sends it.
  return createUserMessage({
    provenance: { kind: "runtime_context", source },
    content: formatRuntimeContextRemovalMessageContent(source),
  });
}

export function resolveRuntimeContextMessages(
  messages: readonly Message[],
  snapshots?: readonly PromptContextSnapshot[],
): Array<{ index: number; message: UserMessage }> {
  const latestBySource = new Map<string, { index: number; message: RuntimeContextMessage }>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || !isRuntimeContextMessage(message)) {
      continue;
    }
    latestBySource.set(message.provenance.source, { index, message });
  }

  const activeContentBySource =
    snapshots === undefined
      ? undefined
      : new Map(
          snapshots.map((snapshot) => [
            snapshot.source,
            formatRuntimeContextMessageContent(snapshot),
          ]),
        );

  return [...latestBySource.values()]
    .filter(({ message }) => {
      // Explicit snapshots are the current assembly result. Omitting them lets
      // replay-only callers infer current state from the append-only journal.
      if (!activeContentBySource) {
        return !isRuntimeContextRemovalMessage(message);
      }
      return (
        activeContentBySource.get(message.provenance.source) === message.content &&
        !isRuntimeContextRemovalMessage(message)
      );
    })
    .sort((left, right) => left.index - right.index);
}

export function projectRuntimeContextMessages(
  messages: readonly Message[],
  snapshots?: readonly PromptContextSnapshot[],
): Message[] {
  const activeIds = new Set(
    resolveRuntimeContextMessages(messages, snapshots).map(({ message }) => message.id),
  );
  return messages.filter(
    (message) => message.provenance.kind !== "runtime_context" || activeIds.has(message.id),
  );
}

function formatSystemSections(sections: readonly PromptSystemSection[]): string | undefined {
  const content = sections
    .map((section) => section.content.trimEnd())
    .filter(Boolean)
    .join("\n\n");
  return content || undefined;
}

function formatRuntimeContextMessageContent(snapshot: PromptContextSnapshot): string {
  return [
    `<runtime_context source="${escapeXmlAttribute(snapshot.source)}">`,
    snapshot.content,
    "</runtime_context>",
  ].join("\n");
}

function formatRuntimeContextRemovalMessageContent(source: string): string {
  return `<runtime_context source="${escapeXmlAttribute(source)}" status="inactive" />`;
}

function isRuntimeContextRemovalMessage(message: RuntimeContextMessage): boolean {
  return message.content === formatRuntimeContextRemovalMessageContent(message.provenance.source);
}

function isRuntimeContextMessage(message: Message): message is RuntimeContextMessage {
  return message.role === "user" && message.provenance.kind === "runtime_context";
}

function assertUniqueSectionNames(
  sections: readonly { name: string }[],
  kind: "system" | "context" | "tool",
): void {
  const names = new Set<string>();
  for (const section of sections) {
    if (!section.name.trim()) {
      throw new Error(`Prompt ${kind} section name cannot be empty.`);
    }
    if (names.has(section.name)) {
      throw new Error(`Duplicate prompt ${kind} section name: ${section.name}.`);
    }
    names.add(section.name);
  }
}

function assertUniqueToolNames(tools: readonly Tool[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate prompt tool name: ${tool.name}.`);
    }
    names.add(tool.name);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new Error("Prompt assembly aborted.");
  }
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
