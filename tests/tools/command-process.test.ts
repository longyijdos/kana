import { describe, expect, test } from "bun:test";
import { resolveShell } from "../../src/tools/command-process";

describe("command shell resolution", () => {
  test.each(["sh", "bash", "zsh"])("accepts %s as a name or executable path", (name) => {
    expect(resolveShell(name)).toBe(name);
    expect(resolveShell(`/bin/${name}`)).toBe(`/bin/${name}`);
  });

  test.each(["", " ", "/usr/bin/fish", "/usr/local/bin/nu", "/bin/dash", "/custom/shell"])(
    "falls back to bash for %j",
    (shell) => {
      expect(resolveShell(shell)).toBe("bash");
    },
  );
});
