import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import test from "node:test";
import { HostControls } from "./host-ui.mjs";

test("unconfirmed host stop keeps the status bar and emergency shortcut until acknowledgement", () => {
  const registrations = new Set();
  const windows = [];
  let state = { threads: { task: { hostAuthorized: true } }, control: { desktop: "agent" },
    hostEngaged: true, stopping: false, lease: { running: true }, lastStop: null };
  class FakeWindow {
    constructor() {
      this.visible = false;
      this.messages = [];
      this.webContents = { on() {}, send: (_channel, value) => this.messages.push(value) };
      windows.push(this);
    }
    isDestroyed() { return false; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    destroy() { this.visible = false; }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    async loadFile() {}
  }
  const controls = new HostControls({ broker: { state: () => state },
    preferencesPath: join(tmpdir(), `cleo-missing-host-ui-${process.pid}.json`),
    files: { preload: "fake", statusHtml: "fake" }, electron: {
      BrowserWindow: FakeWindow,
      screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920 } }) },
      globalShortcut: { register: key => { registrations.add(key); return true; },
        unregister: key => registrations.delete(key) },
    } });
  controls.update();
  state = { threads: {}, control: { desktop: "user" }, hostEngaged: false, stopping: false,
    inflight: [], lease: null, lastStop: { hostError: "native stop not acknowledged", settled: false } };
  controls.update();
  assert.equal(windows[0].isVisible(), true);
  assert.equal(controls.status().shortcutActive, true);
  assert.equal(windows[0].messages.at(-1).stopping, true);
  state.lastStop = { hostError: null, settled: true };
  controls.update();
  assert.equal(windows[0].isVisible(), false);
  assert.equal(registrations.size, 0);
  controls.close();
});

test("status overlay cannot hand back control while stopping is unconfirmed", async () => {
  const listeners = new Map();
  const sent = [];
  const nodes = new Map();
  for (const selector of ["[data-label]", "[data-shortcut]", "[data-action='takeover-desktop']", "[data-action='handback-desktop']"]) {
    nodes.set(selector, { hidden: false, disabled: false, textContent: "", addEventListener() {} });
  }
  const handback = nodes.get("[data-action='handback-desktop']");
  handback.dataset = { action: "handback-desktop" };
  handback.addEventListener = (_name, handler) => { handback.click = handler; };
  const context = { require: () => ({ ipcRenderer: { send: (...args) => sent.push(args),
    on: (name, handler) => listeners.set(name, handler) } }),
    window: { addEventListener: (_name, handler) => handler() },
    document: { querySelector: selector => nodes.get(selector), querySelectorAll: () => [handback] } };
  vm.runInNewContext(await readFile(new URL("./overlay-preload.cjs", import.meta.url), "utf8"), context);
  listeners.get("cleo:computer:status")(null, { control: "user", stopping: true, shortcut: "Control+Alt+Escape" });
  assert.equal(handback.hidden, true);
  handback.click({ preventDefault() {} });
  assert.equal(sent.length, 0);
  assert.match(nodes.get("[data-label]").textContent, /正在停止/);
  listeners.get("cleo:computer:status")(null, { control: "user", stopping: false, shortcut: "Control+Alt+Escape" });
  assert.equal(handback.hidden, false);
  handback.click({ preventDefault() {} });
  assert.deepEqual(sent, [["cleo:computer:overlay", "handback-desktop"]]);
});
