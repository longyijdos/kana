const MODIFIER_SHIFT = 1;
const MODIFIER_ALT = 2;
const MODIFIER_CTRL = 4;
const MODIFIER_SUPER = 8;
const MODIFIER_HYPER = 16;
const MODIFIER_META = 32;
const MODIFIER_LOCKS = 64 | 128;

type ModifiedKey = {
  code: number;
  modifierBits: number;
  eventType?: number;
};

export function isCtrlC(data: string): boolean {
  const key = parseModifiedKey(data);

  return data === "\x03" || isCtrlModifiedCode(key, 3, "c");
}

export function isCtrlO(data: string): boolean {
  const key = parseModifiedKey(data);

  return data === "\x0f" || isCtrlModifiedCode(key, 15, "o");
}

export function isEscape(data: string): boolean {
  const key = parseModifiedKey(data);

  return data === "\x1b" || isUnmodifiedKey(key, 27);
}

export function isEnter(data: string): boolean {
  const key = parseModifiedKey(data);

  return data === "\r" || data === "\n" || isUnmodifiedKey(key, 13);
}

export function isShiftEnter(data: string): boolean {
  const key = parseModifiedKey(data);

  return (
    key?.code === 13 &&
    isPress(key) &&
    (key.modifierBits & MODIFIER_SHIFT) !== 0 &&
    (key.modifierBits &
      (MODIFIER_ALT | MODIFIER_CTRL | MODIFIER_SUPER | MODIFIER_HYPER | MODIFIER_META)) ===
      0
  );
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

function parseModifiedKey(data: string): ModifiedKey | undefined {
  // Kitty CSI-u: ESC [ code ; modifiers[:event-type] u
  const csiU = /^\x1b\[(\d+)(?::\d*)?(?:;(\d+)(?::(\d+))?)?u$/.exec(data);

  if (csiU) {
    return {
      code: Number(csiU[1]),
      modifierBits: Number(csiU[2] ?? "1") - 1,
      eventType: csiU[3] === undefined ? undefined : Number(csiU[3]),
    };
  }

  // xterm modifyOtherKeys format: ESC [ 27 ; modifiers ; code ~
  const modifyOtherKeys = /^\x1b\[27;(\d+);(\d+)~$/.exec(data);

  if (modifyOtherKeys) {
    return {
      code: Number(modifyOtherKeys[2]),
      modifierBits: Number(modifyOtherKeys[1]) - 1,
    };
  }

  return undefined;
}

function isPress(key: ModifiedKey | undefined): boolean {
  return key !== undefined && (key.eventType === undefined || key.eventType === 1);
}

function isUnmodifiedKey(key: ModifiedKey | undefined, code: number): boolean {
  return key?.code === code && isPress(key) && (key.modifierBits & ~MODIFIER_LOCKS) === 0;
}

function isCtrlModifiedCode(
  key: ModifiedKey | undefined,
  controlCode: number,
  char: string,
): boolean {
  if (!isPress(key) || key === undefined || (key.modifierBits & MODIFIER_CTRL) === 0) {
    return false;
  }

  const charCode = char.codePointAt(0);

  return key.code === controlCode || key.code === charCode;
}
