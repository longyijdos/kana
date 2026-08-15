const MODIFIER_SHIFT = 1;
const MODIFIER_ALT = 2;
const MODIFIER_CTRL = 4;
const MODIFIER_SUPER = 8;
const MODIFIER_HYPER = 16;
const MODIFIER_META = 32;
const MODIFIER_LOCKS = 64 | 128;

type ModifiedKey = {
  code: number;
  alternateCodes: number[];
  modifierBits: number;
  eventType?: number;
};

type NavigationKey = {
  direction: "up" | "down" | "right" | "left" | "home" | "end";
  modifierBits: number;
  eventType?: number;
};

type KeyModifier = "alt" | "ctrl";

export function isCtrlC(data: string): boolean {
  const key = parseModifiedKey(data);

  return data === "\x03" || isCtrlModifiedCode(key, 3, "c");
}

export function isCtrlO(data: string): boolean {
  const key = parseModifiedKey(data);

  return data === "\x0f" || isCtrlModifiedCode(key, 15, "o");
}

export function isCtrlV(data: string): boolean {
  const key = parseModifiedKey(data);

  return data === "\x16" || isCtrlModifiedCode(key, 22, "v");
}

export function isCtrlKey(data: string, char: string): boolean {
  const normalized = char.toLowerCase();
  const charCode = normalized.codePointAt(0);

  if (char.length !== 1 || charCode === undefined || charCode > 127) {
    return false;
  }

  const controlCode = charCode & 31;
  if (data === String.fromCharCode(controlCode)) {
    return true;
  }

  return isModifiedCode(parseModifiedKey(data), [controlCode, charCode], MODIFIER_CTRL, true);
}

export function isAltKey(data: string, char: string): boolean {
  const normalized = char.toLowerCase();
  const charCode = normalized.codePointAt(0);

  if (char.length !== 1 || charCode === undefined) {
    return false;
  }

  return (
    data === `\x1b${normalized}` ||
    isModifiedCode(parseModifiedKey(data), [charCode], MODIFIER_ALT, true)
  );
}

export function isModifiedCursorKey(
  data: string,
  direction: "up" | "down" | "right" | "left",
  modifier: KeyModifier,
): boolean {
  const key = parseNavigationKey(data);

  return (
    key?.direction === direction &&
    isPressOrRepeat(key) &&
    hasOnlyModifiers(key.modifierBits, modifierBit(modifier))
  );
}

export function isModifiedBackspace(data: string, modifier: KeyModifier): boolean {
  if (modifier === "alt" && (data === "\x1b\x7f" || data === "\x1b\b")) {
    return true;
  }

  return isModifiedCode(parseModifiedKey(data), [8, 127], modifierBit(modifier), true);
}

export function isModifiedDelete(data: string, modifier: KeyModifier): boolean {
  const key = parseTildeKey(data);

  return (
    key?.code === 3 &&
    isPressOrRepeat(key) &&
    hasOnlyModifiers(key.modifierBits, modifierBit(modifier))
  );
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
  const key = parseTildeKey(data);

  return key?.code === 3 && isPressOrRepeat(key) && hasOnlyModifiers(key.modifierBits, 0);
}

export function isTab(data: string): boolean {
  return data === "\t";
}

export function isUp(data: string): boolean {
  return isCursorKey(data, "up");
}

export function isDown(data: string): boolean {
  return isCursorKey(data, "down");
}

export function isRight(data: string): boolean {
  return isCursorKey(data, "right");
}

export function isLeft(data: string): boolean {
  return isCursorKey(data, "left");
}

export function isHome(data: string): boolean {
  const key = parseNavigationKey(data);

  return (
    data === "\x1b[1~" ||
    (key?.direction === "home" && isPressOrRepeat(key) && hasOnlyModifiers(key.modifierBits, 0))
  );
}

export function isEnd(data: string): boolean {
  const key = parseNavigationKey(data);

  return (
    data === "\x1b[4~" ||
    (key?.direction === "end" && isPressOrRepeat(key) && hasOnlyModifiers(key.modifierBits, 0))
  );
}

export function isPageUp(data: string): boolean {
  return data === "\x1b[5~";
}

export function isPageDown(data: string): boolean {
  return data === "\x1b[6~";
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
  // Kitty CSI-u: ESC [ code[:shifted-code[:base-layout-code]] ;
  // modifiers[:event-type] [;text-as-codepoints] u
  const csiU = /^\x1b\[(\d+(?::\d*)*)(?:;(\d*)(?::(\d+))?)?(?:;[\d:]*)?u$/.exec(data);

  if (csiU) {
    const [code, ...alternateCodes] = csiU[1]
      .split(":")
      .map((value) => (value ? Number(value) : undefined));

    return {
      code: code ?? 0,
      alternateCodes: alternateCodes.filter((value): value is number => value !== undefined),
      modifierBits: Number(csiU[2] || "1") - 1,
      eventType: csiU[3] === undefined ? undefined : Number(csiU[3]),
    };
  }

  // xterm modifyOtherKeys format: ESC [ 27 ; modifiers ; code ~
  const modifyOtherKeys = /^\x1b\[27;(\d+);(\d+)~$/.exec(data);

  if (modifyOtherKeys) {
    return {
      code: Number(modifyOtherKeys[2]),
      alternateCodes: [],
      modifierBits: Number(modifyOtherKeys[1]) - 1,
    };
  }

  return undefined;
}

function parseNavigationKey(data: string): NavigationKey | undefined {
  // Enhanced keyboard mode reports navigation key repeat/release events as
  // CSI 1 ; modifiers : event-type A/B/C/D/F/H.
  const cursorKey = /^\x1b\[(?:(\d+);(\d+)(?::(\d+))?)?([ABCDFH])$/.exec(data);

  if (!cursorKey) {
    return undefined;
  }

  const direction = cursorDirection(cursorKey[4]);

  if (!direction) {
    return undefined;
  }

  return {
    direction,
    modifierBits: Number(cursorKey[2] ?? "1") - 1,
    eventType: cursorKey[3] === undefined ? undefined : Number(cursorKey[3]),
  };
}

function cursorDirection(finalByte: string | undefined): NavigationKey["direction"] | undefined {
  switch (finalByte) {
    case "A":
      return "up";
    case "B":
      return "down";
    case "C":
      return "right";
    case "D":
      return "left";
    case "H":
      return "home";
    case "F":
      return "end";
    default:
      return undefined;
  }
}

function parseTildeKey(data: string): ModifiedKey | undefined {
  const key = /^\x1b\[(\d+)(?:;(\d+)(?::(\d+))?)?~$/.exec(data);

  if (!key) {
    return undefined;
  }

  return {
    code: Number(key[1]),
    alternateCodes: [],
    modifierBits: Number(key[2] ?? "1") - 1,
    eventType: key[3] === undefined ? undefined : Number(key[3]),
  };
}

function isPress(key: ModifiedKey | undefined): boolean {
  return key !== undefined && (key.eventType === undefined || key.eventType === 1);
}

function isPressOrRepeat(key: { eventType?: number } | undefined): boolean {
  return (
    key !== undefined && (key.eventType === undefined || key.eventType === 1 || key.eventType === 2)
  );
}

function isUnmodifiedKey(key: ModifiedKey | undefined, code: number): boolean {
  return keyMatchesCode(key, code) && isPress(key) && hasOnlyModifiers(key.modifierBits, 0);
}

function isCursorKey(data: string, direction: NavigationKey["direction"]): boolean {
  const key = parseNavigationKey(data);

  return (
    key?.direction === direction && isPressOrRepeat(key) && hasOnlyModifiers(key.modifierBits, 0)
  );
}

function isCtrlModifiedCode(
  key: ModifiedKey | undefined,
  controlCode: number,
  char: string,
): boolean {
  const charCode = char.codePointAt(0);

  return (
    charCode !== undefined && isModifiedCode(key, [controlCode, charCode], MODIFIER_CTRL, false)
  );
}

function isModifiedCode(
  key: ModifiedKey | undefined,
  codes: number[],
  modifierBits: number,
  allowRepeat: boolean,
): boolean {
  return (
    key !== undefined &&
    (allowRepeat ? isPressOrRepeat(key) : isPress(key)) &&
    hasOnlyModifiers(key.modifierBits, modifierBits) &&
    codes.some((code) => keyMatchesCode(key, code))
  );
}

function keyMatchesCode(key: ModifiedKey | undefined, code: number): key is ModifiedKey {
  return key !== undefined && (key.code === code || key.alternateCodes.includes(code));
}

function hasOnlyModifiers(actual: number, required: number): boolean {
  return (actual & ~MODIFIER_LOCKS) === required;
}

function modifierBit(modifier: KeyModifier): number {
  return modifier === "alt" ? MODIFIER_ALT : MODIFIER_CTRL;
}
