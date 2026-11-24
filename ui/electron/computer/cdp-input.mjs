/** DevTools-protocol input shared by the built-in browser and the user's browser.
 *
 * Both targets speak the same protocol (Electron's ``webContents.debugger`` and Chrome's
 * ``chrome.debugger`` through the Cleo extension), so mouse, keyboard and text input are built
 * here once. ``send`` dispatches one input command and may reject with ``{ dialog: true }`` when
 * the page opens a JavaScript dialog; ``command`` is a plain command used to release inputs.
 * ``pressed`` records buttons and modifiers currently held by Cleo so a stop can release them.
 * Coordinates are CSS pixels of the page's visual viewport.
 */

import { MODIFIER_VK, modifierMask, parseShortcut } from "./keys.mjs";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function moveTo(send, point) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "none", pointerType: "mouse" });
}

export async function clickAt(send, point, { button = "left", clicks = 1 } = {}, pressed) {
  await moveTo(send, point);
  const bit = { left: 1, right: 2, middle: 4 }[button];
  for (let count = 1; count <= clicks; count++) {
    pressed.add(button);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button, buttons: bit, clickCount: count, pointerType: "mouse" });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button, buttons: 0, clickCount: count, pointerType: "mouse" });
    pressed.delete(button);
  }
}

export async function dragBetween(send, start, end, pressed, signal, release) {
  await moveTo(send, start);
  pressed.add("left");
  try {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...start, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
    const steps = 12;
    for (let step = 1; step <= steps; step++) {
      signal?.throwIfAborted();
      const point = { x: start.x + (end.x - start.x) * step / steps, y: start.y + (end.y - start.y) * step / steps };
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "left", buttons: 1, pointerType: "mouse" });
      await wait(16);
    }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...end, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
    pressed.delete("left");
  } finally {
    if (pressed.has("left")) await release().catch(() => {});
  }
}

export async function wheelAt(send, point, deltaX, deltaY) {
  await moveTo(send, point);
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX, deltaY, pointerType: "mouse" });
  await wait(250);
}

/** Text goes in with insertText (any language, no key events); line breaks press Enter. Long
 * text is chunked so a stop takes effect between chunks.
 */
export async function insertText(send, command, text, signal, pressed) {
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    signal?.throwIfAborted();
    if (index) await pressKeys(send, command, parseShortcut("Enter"), pressed);
    for (let offset = 0; offset < lines[index].length; offset += 500) {
      signal?.throwIfAborted();
      await send("Input.insertText", { text: lines[index].slice(offset, offset + 500) });
    }
  }
}

export async function pressKeys(send, command, { modifiers, key }, pressed) {
  let mask = 0;
  const down = [];
  try {
    for (const name of modifiers) {
      mask |= modifierMask([name]);
      down.push(name);
      pressed.add(`key:${name}`);
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: name, code: `${name}Left`, windowsVirtualKeyCode: MODIFIER_VK[name], modifiers: mask });
    }
    if (key) {
      const printable = key.text && !(mask & ~modifierMask(["Shift"]));
      const text = printable ? (mask & modifierMask(["Shift"]) ? key.text.toUpperCase() : key.text) : "";
      const keyName = key.key.length === 1 && (mask & modifierMask(["Shift"])) ? key.key.toUpperCase() : key.key;
      await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: keyName, code: key.code,
        windowsVirtualKeyCode: key.keyCode, modifiers: mask, ...(text ? { text, unmodifiedText: key.text } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers: mask });
    }
  } finally {
    for (const name of down.reverse()) {
      mask &= ~modifierMask([name]);
      await command("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: `${name}Left`, windowsVirtualKeyCode: MODIFIER_VK[name], modifiers: mask }).catch(() => {});
      pressed.delete(`key:${name}`);
    }
  }
}

/** Purpose: Release mouse buttons and modifiers an interrupted action left pressed. */
export async function releasePressed(command, pressed) {
  const released = [];
  for (const item of [...pressed]) {
    if (item.startsWith("key:")) {
      const name = item.slice(4);
      await command("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: `${name}Left`, windowsVirtualKeyCode: MODIFIER_VK[name], modifiers: 0 }).catch(() => {});
    } else {
      await command("Input.dispatchMouseEvent", { type: "mouseReleased", x: 0, y: 0, button: item, buttons: 0, clickCount: 1 }).catch(() => {});
    }
    pressed.delete(item);
    released.push(item);
  }
  return released;
}

/** Visible text and interactive elements, with element centres in screenshot pixels. */
export function pageTextScript(limit, scale = 1) {
  return `(() => {
      const text = (document.body?.innerText || "").replace(/\\n{3,}/g, "\\n\\n").slice(0, ${Math.max(500, Math.min(limit, 20000))});
      const selector = 'a[href],button,input,select,textarea,[role=button],[role=link],[contenteditable=true],summary';
      const items = [];
      for (const element of document.querySelectorAll(selector)) {
        const box = element.getBoundingClientRect();
        if (box.width < 2 || box.height < 2 || box.bottom < 0 || box.right < 0 || box.top > innerHeight || box.left > innerWidth) continue;
        const style = getComputedStyle(element);
        if (style.visibility === "hidden" || style.display === "none") continue;
        const label = (element.getAttribute("aria-label") || element.innerText || element.value || element.placeholder || element.title || element.name || "").trim().replace(/\\s+/g, " ").slice(0, 80);
        items.push({ tag: element.tagName.toLowerCase(), type: element.type || "", label,
          x: Math.round((box.left + box.width / 2) * ${scale}), y: Math.round((box.top + box.height / 2) * ${scale}) });
        if (items.length >= 80) break;
      }
      return { title: document.title, url: location.href, text, elements: items };
    })()`;
}
