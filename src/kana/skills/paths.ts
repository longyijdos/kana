import { realpathSync } from "node:fs";
import path from "node:path";

export function canonicalizePath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export function isPathInside(candidatePath: string, dir: string): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
