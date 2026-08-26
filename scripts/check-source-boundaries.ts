import path from "node:path";
import { inspectSourceBoundaries, type SourceFileInput } from "./source-boundaries";

const sourceRoot = path.resolve("src");
const files: SourceFileInput[] = [];
for await (const filePath of new Bun.Glob("**/*.ts").scan({
  cwd: sourceRoot,
  absolute: true,
  onlyFiles: true,
})) {
  files.push({ path: filePath, source: await Bun.file(filePath).text() });
}

const violations = inspectSourceBoundaries(sourceRoot, files);
if (violations.length > 0) {
  console.error("Source boundary check failed:");
  for (const violation of violations) {
    const relativePath = path.relative(process.cwd(), violation.path).split(path.sep).join("/");
    console.error(`${relativePath}:${violation.line} [${violation.code}] ${violation.message}`);
  }
  process.exitCode = 1;
}
