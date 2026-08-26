import path from "node:path";
import * as ts from "typescript";

export type SourceFileInput = {
  path: string;
  source: string;
};

type SourceBoundaryViolationCode =
  | "dependency-direction"
  | "import-style"
  | "runtime-cycle"
  | "type-inclusive-cycle"
  | "unknown-module"
  | "unresolved-import";

export type SourceBoundaryViolation = {
  code: SourceBoundaryViolationCode;
  path: string;
  line: number;
  message: string;
};

type DependencyKind = "runtime" | "type";

type ModuleReference = {
  specifier: string;
  kinds: DependencyKind[];
  line: number;
};

type Dependency = {
  from: string;
  to: string;
  kind: DependencyKind;
};

const ALLOWED_TOP_LEVEL_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  main: ["cli", "headless", "kana", "tui"],
  cli: ["headless", "kana", "oauth", "tui", "version"],
  tui: ["agent", "core", "jobs", "kana", "logging", "mcp", "tools", "utils", "version"],
  headless: ["agent", "core", "kana", "logging", "mcp"],
  kana: ["agent", "core", "jobs", "logging", "mcp", "oauth", "providers", "tools", "version"],
  agent: ["core", "logging", "tools"],
  providers: ["core", "logging"],
  mcp: ["oauth", "tools"],
  tools: ["core", "jobs", "utils"],
  utils: ["core"],
  jobs: ["logging"],
  oauth: [],
  logging: [],
  core: [],
  version: [],
};

export function inspectSourceBoundaries(
  sourceRoot: string,
  inputs: readonly SourceFileInput[],
): SourceBoundaryViolation[] {
  const absoluteRoot = path.resolve(sourceRoot);
  const files = new Map(
    inputs.map((input) => [path.resolve(input.path), { ...input, path: path.resolve(input.path) }]),
  );
  const violations: SourceBoundaryViolation[] = [];
  const dependencies: Dependency[] = [];

  for (const file of files.values()) {
    const sourceModule = getTopLevelModule(absoluteRoot, file.path);
    if (!sourceModule || !(sourceModule in ALLOWED_TOP_LEVEL_DEPENDENCIES)) {
      violations.push({
        code: "unknown-module",
        path: file.path,
        line: 1,
        message: `Source file belongs to an unconfigured top-level module: ${sourceModule ?? "outside src"}.`,
      });
      continue;
    }

    for (const reference of collectModuleReferences(file.path, file.source)) {
      const resolved = resolveSourceReference(absoluteRoot, file.path, reference.specifier, files);
      if (resolved === "external") {
        continue;
      }
      if (resolved === undefined) {
        violations.push({
          code: "unresolved-import",
          path: file.path,
          line: reference.line,
          message: `Cannot resolve source import ${JSON.stringify(reference.specifier)}.`,
        });
        continue;
      }

      const targetModule = getTopLevelModule(absoluteRoot, resolved);
      if (!targetModule || !(targetModule in ALLOWED_TOP_LEVEL_DEPENDENCIES)) {
        violations.push({
          code: "unknown-module",
          path: file.path,
          line: reference.line,
          message: `Import targets an unconfigured top-level module: ${targetModule ?? "outside src"}.`,
        });
        continue;
      }

      const styleViolation = inspectImportStyle(sourceModule, targetModule, reference.specifier);
      if (styleViolation) {
        violations.push({
          code: "import-style",
          path: file.path,
          line: reference.line,
          message: styleViolation,
        });
      }

      if (
        sourceModule !== targetModule &&
        !ALLOWED_TOP_LEVEL_DEPENDENCIES[sourceModule]!.includes(targetModule)
      ) {
        violations.push({
          code: "dependency-direction",
          path: file.path,
          line: reference.line,
          message: `${sourceModule} must not depend on ${targetModule}.`,
        });
      }

      for (const kind of reference.kinds) {
        dependencies.push({ from: file.path, to: resolved, kind });
      }
    }
  }

  violations.push(...inspectCycles(absoluteRoot, files, dependencies));
  return violations.sort(compareViolations);
}

function collectModuleReferences(filePath: string, source: string): ModuleReference[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const references: ModuleReference[] = [];

  const addReference = (node: ts.Node, specifier: string, kinds: DependencyKind[]): void => {
    references.push({
      specifier,
      kinds,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      addReference(node, node.moduleSpecifier.text, getImportKinds(node));
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      addReference(node, node.moduleSpecifier.text, getExportKinds(node));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      addReference(node, node.moduleReference.expression.text, [
        node.isTypeOnly ? "type" : "runtime",
      ]);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const [argument] = node.arguments;
      if (node.arguments.length === 1 && argument && ts.isStringLiteral(argument)) {
        addReference(node, argument.text, ["runtime"]);
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      addReference(node, node.argument.literal.text, ["type"]);
    }

    node.forEachChild(visit);
  };

  visit(sourceFile);
  return references;
}

function getImportKinds(node: ts.ImportDeclaration): DependencyKind[] {
  const clause = node.importClause;
  if (!clause || clause.isTypeOnly) {
    return clause ? ["type"] : ["runtime"];
  }

  const kinds = new Set<DependencyKind>();
  if (clause.name || (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))) {
    kinds.add("runtime");
  }
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const element of clause.namedBindings.elements) {
      kinds.add(element.isTypeOnly ? "type" : "runtime");
    }
  }
  return kinds.size > 0 ? [...kinds] : ["runtime"];
}

function getExportKinds(node: ts.ExportDeclaration): DependencyKind[] {
  if (node.isTypeOnly) {
    return ["type"];
  }
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) {
    return ["runtime"];
  }

  const kinds = new Set<DependencyKind>();
  for (const element of node.exportClause.elements) {
    kinds.add(element.isTypeOnly ? "type" : "runtime");
  }
  return kinds.size > 0 ? [...kinds] : ["runtime"];
}

function resolveSourceReference(
  sourceRoot: string,
  from: string,
  specifier: string,
  files: ReadonlyMap<string, SourceFileInput>,
): string | "external" | undefined {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.join(sourceRoot, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(from), specifier);
    if (!isWithin(sourceRoot, base)) {
      return "external";
    }
  } else {
    return "external";
  }

  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  if (base.endsWith(".js")) {
    candidates.push(`${base.slice(0, -3)}.ts`);
  }
  return candidates.find((candidate) => files.has(path.resolve(candidate)));
}

function inspectImportStyle(
  sourceModule: string,
  targetModule: string,
  specifier: string,
): string | undefined {
  if (sourceModule === targetModule) {
    return specifier.startsWith(".")
      ? undefined
      : `Imports within ${sourceModule} must use relative paths.`;
  }

  const expected = `@/${targetModule}`;
  return specifier === expected
    ? undefined
    : `Cross-top-level imports must use the target barrel ${JSON.stringify(expected)}.`;
}

function inspectCycles(
  sourceRoot: string,
  files: ReadonlyMap<string, SourceFileInput>,
  dependencies: readonly Dependency[],
): SourceBoundaryViolation[] {
  const runtimeComponents = findCyclicComponents(
    files.keys(),
    dependencies.filter((dependency) => dependency.kind === "runtime"),
  );
  const runtimeMembership = new Map<string, number>();
  runtimeComponents.forEach((component, index) => {
    for (const file of component) {
      runtimeMembership.set(file, index);
    }
  });

  const violations = runtimeComponents.map((component) =>
    createCycleViolation(sourceRoot, "runtime-cycle", component),
  );
  for (const component of findCyclicComponents(files.keys(), dependencies)) {
    const runtimeComponent = runtimeMembership.get(component[0]!);
    if (
      runtimeComponent !== undefined &&
      component.every((file) => runtimeMembership.get(file) === runtimeComponent)
    ) {
      continue;
    }
    violations.push(createCycleViolation(sourceRoot, "type-inclusive-cycle", component));
  }
  return violations;
}

function findCyclicComponents(
  files: Iterable<string>,
  dependencies: readonly Dependency[],
): string[][] {
  const nodes = [...files].sort();
  const adjacency = new Map(nodes.map((file) => [file, [] as string[]]));
  for (const dependency of dependencies) {
    adjacency.get(dependency.from)?.push(dependency.to);
  }
  for (const targets of adjacency.values()) {
    targets.sort();
  }

  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (node: string): void => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of adjacency.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(target)!));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) {
      return;
    }

    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);

    const hasSelfCycle =
      component.length === 1 && (adjacency.get(component[0]!) ?? []).includes(component[0]!);
    if (component.length > 1 || hasSelfCycle) {
      components.push(component.sort());
    }
  };

  for (const node of nodes) {
    if (!indices.has(node)) {
      visit(node);
    }
  }
  return components.sort((left, right) => left[0]!.localeCompare(right[0]!));
}

function createCycleViolation(
  sourceRoot: string,
  code: "runtime-cycle" | "type-inclusive-cycle",
  component: readonly string[],
): SourceBoundaryViolation {
  const paths = component.map((file) => toProjectPath(sourceRoot, file));
  const label = code === "runtime-cycle" ? "Runtime" : "Type-inclusive";
  return {
    code,
    path: component[0]!,
    line: 1,
    message: `${label} file dependency cycle: ${paths.join(", ")}.`,
  };
}

function getTopLevelModule(sourceRoot: string, filePath: string): string | undefined {
  const relative = path.relative(sourceRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  const [first, second] = relative.split(path.sep);
  return second === undefined ? path.basename(first, path.extname(first)) : first;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toProjectPath(sourceRoot: string, filePath: string): string {
  return path
    .join(path.basename(sourceRoot), path.relative(sourceRoot, filePath))
    .split(path.sep)
    .join("/");
}

function compareViolations(left: SourceBoundaryViolation, right: SourceBoundaryViolation): number {
  return (
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );
}
