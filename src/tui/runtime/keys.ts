export function isCtrlC(data: string): boolean {
  return data === "\x03";
}

export function isCtrlO(data: string): boolean {
  return data === "\x0f";
}

export function isEscape(data: string): boolean {
  return data === "\x1b";
}

export function isEnter(data: string): boolean {
  return data === "\r" || data === "\n";
}

export function isBackspace(data: string): boolean {
  return data === "\x7f" || data === "\b";
}

export function isDelete(data: string): boolean {
  return data === "\x1b[3~";
}

export function isTab(data: string): boolean {
  return data === "\t";
}

export function isUp(data: string): boolean {
  return data === "\x1b[A";
}

export function isDown(data: string): boolean {
  return data === "\x1b[B";
}

export function isRight(data: string): boolean {
  return data === "\x1b[C";
}

export function isLeft(data: string): boolean {
  return data === "\x1b[D";
}

export function isHome(data: string): boolean {
  return data === "\x1b[H" || data === "\x1b[1~";
}

export function isEnd(data: string): boolean {
  return data === "\x1b[F" || data === "\x1b[4~";
}

export function isPrintable(data: string): boolean {
  if (!data) {
    return false;
  }

  for (const char of data) {
    const code = char.charCodeAt(0);

    if (code < 32 || code === 127 || (code >= 128 && code <= 159)) {
      return false;
    }
  }

  return !data.includes("\x1b");
}
