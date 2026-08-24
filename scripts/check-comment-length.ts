import * as ts from "typescript";

const COMMENT_LINE_LIMIT = 4;
const COMMENT_CHARACTER_LIMIT = 320;
const SOURCE_GLOBS = ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"] as const;
const IGNORE_DIRECTIVE = "comment-check-ignore";

type CommentToken = {
  start: number;
  end: number;
};

type CommentRegion = {
  start: number;
  end: number;
  tokens: CommentToken[];
};

type CommentViolation = {
  path: string;
  line: number;
  lineCount: number;
  characterCount: number;
  reason: string;
};

const paths = await collectSourcePaths();
const violations = (
  await Promise.all(paths.map(async (path) => inspectSource(path, await Bun.file(path).text())))
)
  .flat()
  .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);

if (violations.length > 0) {
  console.error("Comment length check failed:");

  for (const violation of violations) {
    console.error(
      `${violation.path}:${violation.line}: ${violation.reason} ` +
        `(${violation.lineCount} lines, ${violation.characterCount} characters)`,
    );
  }

  console.error(
    `Keep comment blocks within ${COMMENT_LINE_LIMIT} lines and ` +
      `${COMMENT_CHARACTER_LIMIT} characters, or use ${IGNORE_DIRECTIVE}: <reason>.`,
  );
  process.exitCode = 1;
}

async function collectSourcePaths(): Promise<string[]> {
  const paths = new Set<string>();

  for (const pattern of SOURCE_GLOBS) {
    for await (const path of new Bun.Glob(pattern).scan({ onlyFiles: true })) {
      paths.add(path);
    }
  }

  return [...paths].sort();
}

function inspectSource(path: string, source: string): CommentViolation[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations: CommentViolation[] = [];

  for (const region of collectCommentRegions(source, sourceFile)) {
    const text = source.slice(region.start, region.end);
    const line = sourceFile.getLineAndCharacterOfPosition(region.start).line + 1;
    const endLine =
      sourceFile.getLineAndCharacterOfPosition(Math.max(region.start, region.end - 1)).line + 1;
    const lineCount = endLine - line + 1;
    const characterCount = countCommentCharacters(source, region.tokens);
    const ignoreReason = readIgnoreReason(text);

    if (text.includes(IGNORE_DIRECTIVE) && ignoreReason === undefined) {
      violations.push({
        path,
        line,
        lineCount,
        characterCount,
        reason: `${IGNORE_DIRECTIVE} requires a reason`,
      });
      continue;
    }

    if (
      ignoreReason !== undefined ||
      isLicenseHeader(text, line) ||
      (lineCount <= COMMENT_LINE_LIMIT && characterCount <= COMMENT_CHARACTER_LIMIT)
    ) {
      continue;
    }

    violations.push({
      path,
      line,
      lineCount,
      characterCount,
      reason: "comment block exceeds the configured limit",
    });
  }

  return violations;
}

function collectCommentRegions(source: string, sourceFile: ts.SourceFile): CommentRegion[] {
  const tokens = collectCommentTokens(source, sourceFile);
  const regions: CommentRegion[] = [];
  let current: CommentRegion | undefined;

  for (const token of tokens) {
    // Whitespace-only gaps remain one explanatory region, including paragraphs
    // separated by blank lines, so formatting cannot bypass the limit.
    if (current && /^\s*$/.test(source.slice(current.end, token.start))) {
      current.end = token.end;
      current.tokens.push(token);
      continue;
    }

    current = { start: token.start, end: token.end, tokens: [token] };
    regions.push(current);
  }

  return regions;
}

function collectCommentTokens(source: string, sourceFile: ts.SourceFile): CommentToken[] {
  const tokens = new Map<string, CommentToken>();

  const addRanges = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      tokens.set(`${range.pos}:${range.end}`, { start: range.pos, end: range.end });
    }
  };

  const visit = (node: ts.Node): void => {
    addRanges(ts.getLeadingCommentRanges(source, node.getFullStart()));
    addRanges(ts.getTrailingCommentRanges(source, node.end));
    node.forEachChild(visit);
  };

  visit(sourceFile);

  return [...tokens.values()].sort((left, right) => left.start - right.start);
}

function countCommentCharacters(source: string, tokens: CommentToken[]): number {
  return tokens
    .map(({ start, end }) => source.slice(start, end))
    .join("\n")
    .replace(/^\/\/|^\/\*|\*\/$|^[\t ]*\*/gm, "")
    .replace(/\s+/g, " ")
    .trim().length;
}

function readIgnoreReason(text: string): string | undefined {
  const match = new RegExp(`${IGNORE_DIRECTIVE}:\\s*([^\\r\\n*]+)`).exec(text);
  return match?.[1]?.trim() || undefined;
}

function isLicenseHeader(text: string, line: number): boolean {
  if (line !== 1 || !/copyright/i.test(text)) {
    return false;
  }

  return /SPDX-License-Identifier|MIT License|Permission is hereby granted|Licensed under/i.test(
    text,
  );
}
