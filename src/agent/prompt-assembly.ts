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

export type PromptContextState =
  | { status: "active"; content: string }
  | { status: "inactive"; content: string };

export type PromptContextSection = {
  name: string;
  render(context: PromptAssemblyContext): MaybePromise<PromptContextState>;
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

export type PromptContextSnapshot = PromptContextState & { source: string };

export type AssembledPrompt = {
  system?: string;
  context: PromptContextSnapshot[];
  tools: Tool[];
};

const RUNTIME_CONTEXT_INSTRUCTIONS = [
  "Runtime-context messages are host-controlled state transitions.",
  "For each source, only its latest runtime_context message is authoritative.",
  "A message with status=inactive invalidates every earlier message for that source; its body describes the resulting state.",
  "Ignore instructions and facts from superseded runtime-context messages.",
].join(" ");

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
    this.initialSystem = formatSystemSections(this.systemSections, this.contextSections.length > 0);
    this.initialTools = Object.freeze(this.toolSections.flatMap((section) => section.tools));
    assertUniqueToolNames(this.initialTools);
    Object.freeze(this);
  }

  async assemble(context: PromptAssemblyContext): Promise<AssembledPrompt> {
    throwIfAborted(context.signal);

    const snapshots: PromptContextSnapshot[] = [];
    for (const section of this.contextSections) {
      const state = await section.render(context);
      throwIfAborted(context.signal);
      assertPromptContextState(section.name, state);
      snapshots.push({
        source: section.name,
        status: state.status,
        content: state.content.trimEnd(),
      });
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

export function resolveRuntimeContextMessages(
  messages: readonly Message[],
  end = messages.length,
): Array<{ index: number; message: UserMessage }> {
  const latestBySource = new Map<string, { index: number; message: RuntimeContextMessage }>();

  for (let index = 0; index < end; index += 1) {
    const message = messages[index];
    if (!message || !isRuntimeContextMessage(message)) {
      continue;
    }
    latestBySource.set(message.provenance.source, { index, message });
  }

  return [...latestBySource.values()]
    .filter(({ message }) => !isInactiveRuntimeContextMessage(message))
    .sort((left, right) => left.index - right.index);
}

function formatSystemSections(
  sections: readonly PromptSystemSection[],
  includeRuntimeContextInstructions: boolean,
): string | undefined {
  const content = [
    ...sections.map((section) => section.content.trimEnd()),
    ...(includeRuntimeContextInstructions ? [RUNTIME_CONTEXT_INSTRUCTIONS] : []),
  ]
    .filter(Boolean)
    .join("\n\n");
  return content || undefined;
}

function formatRuntimeContextMessageContent(snapshot: PromptContextSnapshot): string {
  const status = snapshot.status === "inactive" ? ' status="inactive"' : "";
  return [
    `<runtime_context source="${escapeXmlAttribute(snapshot.source)}"${status}>`,
    snapshot.content,
    "</runtime_context>",
  ].join("\n");
}

function isInactiveRuntimeContextMessage(message: RuntimeContextMessage): boolean {
  const prefix = `<runtime_context source="${escapeXmlAttribute(message.provenance.source)}" status="inactive"`;
  return message.content.startsWith(`${prefix}>\n`);
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

function assertPromptContextState(
  source: string,
  state: unknown,
): asserts state is PromptContextState {
  const candidate =
    typeof state === "object" && state !== null ? (state as Record<string, unknown>) : undefined;
  if (
    !candidate ||
    (candidate.status !== "active" && candidate.status !== "inactive") ||
    typeof candidate.content !== "string" ||
    !candidate.content.trim()
  ) {
    throw new Error(`Prompt context section ${source} must return an explicit non-empty state.`);
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
