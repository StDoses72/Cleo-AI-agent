/** Keyboard shortcut parsing shared by the built-in browser (CDP) and host desktop tools.
 * Names are case-insensitive and joined with "+", for example "ctrl+shift+tab" or "Enter".
 */

const MODIFIERS = {
  ctrl: "Control", control: "Control",
  alt: "Alt", option: "Alt",
  shift: "Shift",
  meta: "Meta", cmd: "Meta", command: "Meta", win: "Meta", windows: "Meta", super: "Meta",
};

// CDP modifier bit mask: Alt=1, Ctrl=2, Meta=4, Shift=8.
export const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
// Windows virtual-key codes for modifiers.
export const MODIFIER_VK = { Alt: 0x12, Control: 0x11, Meta: 0x5b, Shift: 0x10 };

const NAMED = {
  enter: ["Enter", "Enter", 13, "\r"], return: ["Enter", "Enter", 13, "\r"],
  tab: ["Tab", "Tab", 9, ""],
  esc: ["Escape", "Escape", 27, ""], escape: ["Escape", "Escape", 27, ""],
  backspace: ["Backspace", "Backspace", 8, ""],
  delete: ["Delete", "Delete", 46, ""], del: ["Delete", "Delete", 46, ""],
  insert: ["Insert", "Insert", 45, ""],
  space: [" ", "Space", 32, " "],
  up: ["ArrowUp", "ArrowUp", 38, ""], arrowup: ["ArrowUp", "ArrowUp", 38, ""],
  down: ["ArrowDown", "ArrowDown", 40, ""], arrowdown: ["ArrowDown", "ArrowDown", 40, ""],
  left: ["ArrowLeft", "ArrowLeft", 37, ""], arrowleft: ["ArrowLeft", "ArrowLeft", 37, ""],
  right: ["ArrowRight", "ArrowRight", 39, ""], arrowright: ["ArrowRight", "ArrowRight", 39, ""],
  home: ["Home", "Home", 36, ""], end: ["End", "End", 35, ""],
  pageup: ["PageUp", "PageUp", 33, ""], pgup: ["PageUp", "PageUp", 33, ""],
  pagedown: ["PageDown", "PageDown", 34, ""], pgdn: ["PageDown", "PageDown", 34, ""],
  capslock: ["CapsLock", "CapsLock", 20, ""],
  printscreen: ["PrintScreen", "PrintScreen", 44, ""],
  contextmenu: ["ContextMenu", "ContextMenu", 93, ""], menu: ["ContextMenu", "ContextMenu", 93, ""],
  plus: ["+", "Equal", 187, "+"], minus: ["-", "Minus", 189, "-"],
  equal: ["=", "Equal", 187, "="], comma: [",", "Comma", 188, ","], period: [".", "Period", 190, "."],
  slash: ["/", "Slash", 191, "/"], backslash: ["\\", "Backslash", 220, "\\"],
  semicolon: [";", "Semicolon", 186, ";"], quote: ["'", "Quote", 222, "'"],
  backquote: ["`", "Backquote", 192, "`"],
  bracketleft: ["[", "BracketLeft", 219, "["], bracketright: ["]", "BracketRight", 221, "]"],
};

const PUNCTUATION = {
  "-": "minus", "=": "equal", ",": "comma", ".": "period", "/": "slash", "\\": "backslash",
  ";": "semicolon", "'": "quote", "`": "backquote", "[": "bracketleft", "]": "bracketright",
};

/** Purpose: Describe one non-modifier key. Input: name. Output: key/code/virtual-key/text. */
export function keyInfo(name) {
  const raw = String(name);
  const lower = raw.toLowerCase();
  if (NAMED[lower]) {
    const [key, code, keyCode, text] = NAMED[lower];
    return { key, code, keyCode, text };
  }
  if (PUNCTUATION[raw]) return keyInfo(PUNCTUATION[raw]);
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) {
    const number = Number(lower.slice(1));
    return { key: `F${number}`, code: `F${number}`, keyCode: 111 + number, text: "" };
  }
  if (/^[a-z]$/i.test(raw)) {
    const upper = raw.toUpperCase();
    return { key: raw.length === 1 ? raw.toLowerCase() : raw, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: raw.toLowerCase() };
  }
  if (/^[0-9]$/.test(raw)) return { key: raw, code: `Digit${raw}`, keyCode: raw.charCodeAt(0), text: raw };
  throw new Error(`不支持的按键：${raw}`);
}

/** Purpose: Parse a shortcut such as "ctrl+shift+t".
 * Input: shortcut text. Output: ordered modifier names and one main key (or null for modifier-only).
 */
export function parseShortcut(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 60) throw new Error("快捷键不能为空，且不超过 60 个字符。");
  // Allow "ctrl++" and a literal "+" key.
  const parts = text.replace(/\+\+$/, "+plus").split("+").map(part => part.trim()).filter(Boolean);
  if (!parts.length || parts.length > 5) throw new Error(`无法识别的快捷键：${text}`);
  const modifiers = [];
  let key = null;
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (modifier) {
      if (!modifiers.includes(modifier)) modifiers.push(modifier);
      continue;
    }
    if (key) throw new Error(`一个快捷键只能包含一个主键：${text}`);
    key = keyInfo(part);
  }
  return { modifiers, key, label: [...modifiers, key?.key === " " ? "Space" : key?.key].filter(Boolean).join("+") };
}

/** Purpose: CDP modifier mask. Input: modifier names. Output: bit mask. */
export function modifierMask(modifiers) {
  return modifiers.reduce((mask, name) => mask | (MODIFIER_BITS[name] || 0), 0);
}

/** Purpose: Validate an Electron accelerator chosen for the host emergency stop.
 * Input: user text. Output: normalized accelerator requiring at least two modifiers.
 */
export function stopAccelerator(value) {
  const parsed = parseShortcut(value);
  if (!parsed.key) throw new Error("紧急停止快捷键需要一个主键。");
  if (parsed.modifiers.length < 2) throw new Error("紧急停止快捷键至少需要两个修饰键，避免误触。");
  const names = { Control: "Control", Alt: "Alt", Shift: "Shift", Meta: "Super" };
  const key = parsed.key.key.length === 1 ? parsed.key.key.toUpperCase() : parsed.key.key;
  const electronKey = { Escape: "Escape", " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" }[key] ?? key;
  return [...parsed.modifiers.map(name => names[name]), electronKey].join("+");
}
