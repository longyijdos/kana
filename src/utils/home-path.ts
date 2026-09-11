import { homedir } from "node:os";
import path from "node:path";

// Shell-style expansion: only a leading `~` or `~/` names the home directory.
// `~user` references and later `~` segments stay literal.
export function expandHomePath(inputPath: string, home: string = homedir()): string {
  const remainder = readHomeRemainder(inputPath);

  return remainder === undefined ? inputPath : path.join(home, remainder);
}

function readHomeRemainder(inputPath: string): string | undefined {
  if (inputPath === "~") {
    return "";
  }

  // `~\` counts only where the platform separator is `\`; POSIX treats `\` as a filename character.
  if (inputPath.startsWith("~/") || (path.sep === "\\" && inputPath.startsWith("~\\"))) {
    return inputPath.slice(2);
  }

  return undefined;
}
