import { t as tr } from "../i18n.mjs";
/** The user's own Chrome or Edge, driven through the Cleo extension.
 *
 * The extension's native host opens a ``link`` on Cleo's computer channel (bridge.mjs) and
 * relays messages: Cleo sends ``request`` messages (list tabs, open a background tab, attach the
 * debugger, send one DevTools command) and receives ``response`` and ``event`` messages (tab
 * closed or changed, debugger detached, real user input on a watched page, page dialogs).
 *
 * Every page action is a DevTools command on one tab, the same protocol as the built-in browser,
 * so the real pointer, window focus, clipboard and the tab the user is looking at are never
 * touched. Screenshots are taken of the tab even in the background and scaled to CSS pixels,
 * which are the coordinates the agent uses.
 */

import { EventEmitter } from "node:events";
import { clickAt, dragBetween, insertText, moveTo, pageTextScript, pressKeys, releasePressed, wheelAt } from "./cdp-input.mjs";
import { parseShortcut } from "./keys.mjs";

const REQUEST_TIMEOUT = 15000;
const INPUT_TIMEOUT = 8000;
const BROWSER_NAMES = { chrome: "Chrome", edge: "Microsoft Edge", brave: "Brave", chromium: "Chromium" };

/** One native-host connection: newline-delimited JSON over the bridge socket. */
export class ExtensionLink extends EventEmitter {
  constructor(socket, hello, rest = "") {
    super();
    this.socket = socket;
    this.hello = hello;
    this.pending = new Map();
    this.next = 1;
    this.closed = false;
    let buffer = "";
    const feed = chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        this.receive(message);
      }
    };
    socket.setEncoding?.("utf8");
    socket.on("data", feed);
    socket.on("close", () => this.close());
    socket.on("error", () => this.close());
    if (rest) feed(rest);
  }

  receive(message) {
    if (message?.type === "response") {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new Error(String(message.error || tr("user_browser.request_failed"))));
    } else if (message?.type === "event") {
      this.emit("event", message.event, message.params || {});
    } else if (message?.type === "status" && message.cleo === false) {
      this.close();
    }
  }

  request(op, params = {}, timeout = REQUEST_TIMEOUT) {
    if (this.closed) return Promise.reject(new Error(tr("broker.ub_not_connected")));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(tr("user_browser.timed_out", { p0: op === "debugger.send" ? params.method : op })));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ type: "request", id, op, params })}\n`);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(tr("broker.ub_not_connected"))); }
    this.pending.clear();
    try { this.socket.destroy(); } catch { /* Already closed. */ }
    this.emit("close");
  }
}

export class UserBrowser extends EventEmitter {
  /** Purpose: Track the connected browser. Input: Electron (nativeImage for scaling), whether a
   * connection is currently allowed (the user can disconnect in Settings). */
  constructor({ electron = null, enabled = () => true } = {}) {
    super();
    this.electron = electron;
    this.enabled = enabled;
    this.link = null;
    this.info = null;
    this.tabMap = new Map();
    this.attached = new Set();
    this.pressed = new Map();
    this.geometries = new Map();
    this.dialogs = new Map();
    this.dialogWaiters = new Map();
    // Tab ids are per browser; a new link gets a new generation, so coordinates and screenshots
    // taken through an earlier link (possibly another browser) never match again.
    this.generation = 0;
    this.lastError = "";
  }

  get connected() { return Boolean(this.link && !this.link.closed && this.info); }
  get kind() { return this.info?.browser || ""; }
  get name() { return BROWSER_NAMES[this.info?.browser] || "Chrome"; }

  /** Purpose: Take over a native-host connection from the bridge. Input: socket, hello, rest.
   * One browser at a time: while one is linked, another browser's host is turned away (its host
   * backs off), so two browsers never take turns replacing each other.
   */
  accept(socket, request, rest = "") {
    const hello = request?.hello;
    if (!this.enabled() || hello?.type !== "hello" || this.connected) { try { socket.destroy(); } catch { /* Ignore. */ } return; }
    const link = new ExtensionLink(socket, hello, rest);
    this.link = link;
    this.generation += 1;
    this.info = { browser: String(hello.browser || "chromium"), version: String(hello.version || ""), extension: String(hello.extension || "") };
    this.reset();
    link.on("event", (event, params) => { if (this.link === link) this.event(event, params); });
    link.on("close", () => {
      if (this.link !== link) return;
      this.link = null;
      this.reset();
      this.emit("lost", { reason: "disconnected" });
      this.emit("state");
    });
    // A previous Cleo run may have left tabs attached; start from none so the debugging bar
    // disappears whenever no turn needs the browser.
    void link.request("debugger.detachAll", {}, 5000).catch(() => {});
    void this.refreshTabs().catch(() => {});
    this.emit("state");
  }

  reset() {
    this.tabMap.clear();
    this.attached.clear();
    this.pressed.clear();
    this.geometries.clear();
    this.dialogs.clear();
  }

  /** Purpose: Close the connection (the user disconnected in Settings). The agent stops first. */
  async disconnect() {
    const link = this.link;
    if (!link) return;
    await link.request("debugger.detachAll", {}, 3000).catch(() => {});
    this.link = null;
    this.info = null;
    this.reset();
    this.emit("lost", { reason: "disconnected" });
    link.close();
    this.emit("state");
  }

  event(event, params) {
    const id = String(params.tabId ?? params.id ?? "");
    if (event === "tab.removed") {
      this.tabMap.delete(id);
      this.attached.delete(id);
      this.geometries.delete(id);
      this.emit("tab-removed", id);
    } else if (event === "tab.updated") {
      // A dialog belongs to the page that showed it; a new address means it is gone.
      if (this.tabMap.get(id)?.url !== String(params.url || "")) this.dialogs.delete(id);
      this.tabMap.set(id, this.normalize(params));
      this.emit("tab-updated", id);
    } else if (event === "tab.activated") {
      for (const tab of this.tabMap.values()) if (tab.windowId === params.windowId) tab.active = tab.id === id;
      this.emit("tab-updated", id);
    } else if (event === "debugger.detached") {
      this.attached.delete(id);
      this.pressed.delete(id);
      this.dialogs.delete(id);
      // The user pressed "Cancel" on the browser's debugging bar: Cleo's access is revoked.
      if (params.reason === "canceled_by_user") this.emit("lost", { reason: "canceled_by_user", tabId: id });
    } else if (event === "user.input") {
      this.emit("user-input", { tabId: id, kind: params.kind });
    } else if (event === "debugger.event") {
      this.devtoolsEvent(id, params.method, params.params || {});
    }
    this.emit("state");
  }

  devtoolsEvent(id, method, params) {
    if (method === "Page.javascriptDialogOpening") {
      this.dialogs.set(id, { type: params.type, message: String(params.message || "").slice(0, 2000) });
      for (const resolve of this.dialogWaiters.get(id) || []) resolve();
      this.dialogWaiters.delete(id);
    } else if (method === "Page.javascriptDialogClosed") {
      this.dialogs.delete(id);
    }
  }

  normalize(raw) {
    const id = String(raw.id);
    return { id, windowId: raw.windowId, title: String(raw.title || ""), url: String(raw.url || ""), active: Boolean(raw.active),
      loading: raw.status === "loading", cleo: Boolean(raw.cleo), dialog: this.dialogs.get(id) || null };
  }

  request(op, params, timeout) {
    if (!this.connected) return Promise.reject(new Error(tr("broker.ub_not_connected")));
    return this.link.request(op, params, timeout);
  }

  async refreshTabs() {
    const windows = await this.request("tabs.list");
    const next = new Map();
    for (const window of windows || []) for (const tab of window.tabs || []) next.set(String(tab.id), this.normalize(tab));
    this.tabMap = next;
    this.emit("state");
    return this.tabs();
  }

  tabs() { return [...this.tabMap.values()].map(tab => ({ ...tab, dialog: this.dialogs.get(tab.id) || null })); }

  tab(id) {
    const tab = this.tabMap.get(String(id));
    return tab ? { ...tab, dialog: this.dialogs.get(tab.id) || null } : null;
  }

  requireTab(id) {
    const tab = this.tab(id);
    if (!tab) throw new Error(tr("broker.ub_tab_missing", { p0: id }));
    return tab;
  }

  async openTab(url) {
    const tab = this.normalize(await this.request("tabs.create", { url }));
    this.tabMap.set(tab.id, tab);
    this.emit("state");
    return tab;
  }

  async closeTab(id) {
    this.requireTab(id);
    await this.request("tabs.close", { tabId: Number(id) });
  }

  async attach(id) {
    const tab = this.requireTab(id);
    if (this.attached.has(tab.id)) return tab;
    await this.request("debugger.attach", { tabId: Number(tab.id) });
    this.attached.add(tab.id);
    return tab;
  }

  command(id, method, params = {}, timeout = INPUT_TIMEOUT) {
    return this.request("debugger.send", { tabId: Number(id), method, params }, timeout);
  }

  /** Dispatch input; if the page opens a JavaScript dialog the action stops without waiting. */
  sender(id) {
    return async (method, params) => {
      if (this.dialogs.has(id)) throw Object.assign(new Error(tr("browser.the_page_opened_a_dialog_the_operation_was_paused")), { dialog: true });
      let onDialog;
      const dialog = new Promise(resolve => {
        onDialog = resolve;
        const waiters = this.dialogWaiters.get(id) || new Set();
        waiters.add(resolve);
        this.dialogWaiters.set(id, waiters);
      });
      try {
        const outcome = await Promise.race([this.command(id, method, params).then(() => "done"), dialog.then(() => "dialog")]);
        if (outcome === "dialog") throw Object.assign(new Error(tr("browser.the_page_opened_a_dialog_the_operation_was_paused")), { dialog: true });
      } finally {
        this.dialogWaiters.get(id)?.delete(onDialog);
      }
    };
  }

  releaser(id) { return (method, params) => this.command(id, method, params, 2000); }

  pressedFor(id) {
    let set = this.pressed.get(id);
    if (!set) { set = new Set(); this.pressed.set(id, set); }
    return set;
  }

  async metrics(id) {
    const layout = await this.command(id, "Page.getLayoutMetrics", {}, INPUT_TIMEOUT);
    const viewport = layout.cssVisualViewport || layout.visualViewport;
    const width = Math.max(1, Math.round(viewport.clientWidth));
    const height = Math.max(1, Math.round(viewport.clientHeight));
    return { width, height, geometry: `${this.generation}:${width}x${height}@${viewport.scale ?? 1}` };
  }

  geometry(id) { return this.geometries.get(String(id)) ?? null; }

  /** Coordinates from a screenshot are valid only while the tab keeps the same viewport. */
  async prepareInput(id) {
    await this.attach(id);
    const current = await this.metrics(id);
    if (current.geometry !== this.geometries.get(id)) {
      this.geometries.set(id, current.geometry);
      throw new Error(tr("broker.ub_geometry_changed"));
    }
  }

  /** Purpose: The address the tab shows right now, read from the page itself (the tab list can
   * lag behind a redirect). */
  async liveUrl(id) {
    await this.attach(id);
    const result = await this.command(id, "Runtime.evaluate", { expression: "location.href", returnByValue: true }, INPUT_TIMEOUT);
    return String(result?.result?.value || "");
  }

  /** Purpose: Capture one tab, also in the background. Output: PNG scaled to CSS pixels. */
  async capture(id, signal) {
    const tab = await this.attach(String(id));
    signal?.throwIfAborted();
    const { width, height, geometry } = await this.metrics(tab.id);
    if (this.dialogs.has(tab.id)) throw Object.assign(new Error(tr("broker.the_page_is_showing_a_dialog")), { dialog: true });
    const shot = await this.command(tab.id, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, 20000);
    signal?.throwIfAborted();
    let png = Buffer.from(shot.data, "base64");
    const image = this.electron?.nativeImage?.createFromBuffer(png);
    if (image) {
      const size = image.getSize();
      if (size.width !== width || size.height !== height) png = image.resize({ width, height, quality: "better" }).toPNG();
    }
    this.geometries.set(tab.id, geometry);
    return { png, width, height, geometry };
  }

  async click(id, x, y, options) { await this.prepareInput(id); await clickAt(this.sender(id), { x, y }, options, this.pressedFor(id)); }
  async move(id, x, y) { await this.prepareInput(id); await moveTo(this.sender(id), { x, y }); }
  async drag(id, from, to, signal) {
    await this.prepareInput(id);
    await dragBetween(this.sender(id), from, to, this.pressedFor(id), signal, () => releasePressed(this.releaser(id), this.pressedFor(id)));
  }
  async scroll(id, x, y, deltaX, deltaY) { await this.prepareInput(id); await wheelAt(this.sender(id), { x, y }, deltaX, deltaY); }
  async type(id, text, signal) { await this.prepareInput(id); await insertText(this.sender(id), this.releaser(id), text, signal, this.pressedFor(id)); }
  async keys(id, shortcut) { await this.prepareInput(id); await pressKeys(this.sender(id), this.releaser(id), parseShortcut(shortcut), this.pressedFor(id)); }

  async navigate(id, url) {
    await this.attach(id);
    const result = await this.command(id, "Page.navigate", { url }, REQUEST_TIMEOUT);
    if (result?.errorText) throw new Error(tr("broker.page_loading_failed_value", { p0: result.errorText }));
    await new Promise(resolve => setTimeout(resolve, 800));
  }

  async history(id, action) {
    await this.attach(id);
    if (action === "reload") await this.command(id, "Page.reload");
    else if (action === "stop") await this.command(id, "Page.stopLoading");
    else {
      const { currentIndex, entries } = await this.command(id, "Page.getNavigationHistory");
      const next = entries[currentIndex + (action === "back" ? -1 : 1)];
      if (!next) throw new Error(action === "back" ? tr("browser.there_is_no_previous_page") : tr("browser.there_is_no_next_page"));
      await this.command(id, "Page.navigateToHistoryEntry", { entryId: next.id });
    }
    await new Promise(resolve => setTimeout(resolve, action === "stop" ? 50 : 600));
  }

  async pageText(id, limit = 6000) {
    await this.attach(id);
    const result = await this.command(id, "Runtime.evaluate", { expression: pageTextScript(limit, 1), returnByValue: true }, 10000);
    if (result.exceptionDetails) throw new Error(tr("browser.could_not_read_the_page_content"));
    return result.result.value;
  }

  async handleDialog(id, accept, promptText = "") {
    await this.attach(id);
    if (!this.dialogs.has(id)) throw new Error(tr("browser.the_current_tab_has_no_open_dialog"));
    try {
      await this.command(id, "Page.handleJavaScriptDialog", { accept: Boolean(accept), ...(promptText ? { promptText: String(promptText).slice(0, 2000) } : {}) });
    } finally {
      // Handled, or already dismissed by the user: either way it no longer blocks the tab.
      this.dialogs.delete(id);
    }
  }

  /** Purpose: Release buttons and modifiers Cleo still holds in any tab. Output: what was released. */
  async releaseAll() {
    const released = [];
    for (const [id, set] of this.pressed) if (set.size && this.connected) released.push(...await releasePressed(this.releaser(id), set));
    return released;
  }

  /** Purpose: Detach from every tab, which also removes the browser's debugging bar. */
  async detachAll() {
    if (!this.connected || !this.attached.size) return;
    this.attached.clear();
    this.dialogs.clear();
    await this.request("debugger.detachAll", {}, 5000);
    this.emit("state");
  }

  state() {
    return { connected: this.connected, browser: this.info ? { kind: this.info.browser, name: this.name, version: this.info.version, extension: this.info.extension } : null,
      tabs: this.tabMap.size, attached: this.attached.size };
  }
}
