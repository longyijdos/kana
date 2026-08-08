export function supportsTerminalHyperlinks(env: NodeJS.ProcessEnv = process.env): boolean {
  const term = env.TERM?.toLowerCase();

  // Multiplexers need their own passthrough/version negotiation. Treat them as
  // unsupported until Kana can identify that boundary without guessing.
  if (term === "dumb" || term?.startsWith("screen") || term?.startsWith("tmux")) {
    return false;
  }

  if (env.KITTY_WINDOW_ID || env.WT_SESSION) {
    return true;
  }

  switch (env.TERM_PROGRAM) {
    case "ghostty":
      return true;
    case "iTerm.app":
      return versionAtLeast(env.TERM_PROGRAM_VERSION, 3, 1);
    case "vscode":
      return versionAtLeast(env.TERM_PROGRAM_VERSION, 1, 72);
    case "WezTerm":
      return leadingVersionNumber(env.TERM_PROGRAM_VERSION) >= 20200620;
  }

  if (supportsVteHyperlinks(env.VTE_VERSION)) {
    return true;
  }

  // Alacritty started setting this terminal identity after adding OSC 8.
  return term === "alacritty";
}

function versionAtLeast(value: string | undefined, requiredMajor: number, requiredMinor: number) {
  const [major = 0, minor = 0] = (value ?? "").split(".").map((part) => Number.parseInt(part, 10));
  return major > requiredMajor || (major === requiredMajor && minor >= requiredMinor);
}

function leadingVersionNumber(value: string | undefined): number {
  return Number.parseInt(value ?? "", 10) || 0;
}

function supportsVteHyperlinks(value: string | undefined): boolean {
  if (!value || value === "5000" || value === "0.50.0") {
    return false;
  }

  if (/^\d{3,4}$/.test(value)) {
    return Number.parseInt(value, 10) > 5000;
  }

  return versionAtLeast(value, 0, 50);
}
