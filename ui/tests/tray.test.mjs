import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createTrayController } from "../electron/tray.mjs";
import { createQuitBarrier } from "../electron/shutdown.mjs";

test("memory navigation arriving before React subscribes is delivered once and unsubscribes cleanly", () => {
  const ipcRenderer = new EventEmitter();
  const exposed = {};
  runInNewContext(readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "win32", argv: ["--cleo-desktop-mock"] },
    require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } } }),
  });
  ipcRenderer.emit("cleo:open-memory");
  let calls = 0;
  const unsubscribe = exposed.cleoWindow.onOpenMemory(() => calls++);
  assert.equal(calls, 1);
  ipcRenderer.emit("cleo:open-memory");
  assert.equal(calls, 2);
  unsubscribe();
  ipcRenderer.emit("cleo:open-memory");
  assert.equal(calls, 2);
  const finalUnsubscribe = exposed.cleoWindow.onOpenMemory(() => calls++);
  assert.equal(calls, 3);
  finalUnsubscribe();
});

function event() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

function fixture({ platform = "win32", failure, canOpen = () => true } = {}) {
  const windows = [], trays = [], errors = [], memory = [];
  const app = new EventEmitter();
  app.quitCalls = 0;
  app.quit = () => {
    app.quitCalls++;
    const request = event();
    app.emit("before-quit", request);
    if (request.prevented) return;
    for (const window of windows) if (!window.isDestroyed()) window.close();
    app.emit("will-quit");
  };
  class Window extends EventEmitter {
    visible = true;
    minimized = false;
    destroyed = false;
    focused = false;
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    show() { this.visible = true; this.emit("show"); }
    hide() { this.visible = false; this.focused = false; }
    focus() { this.focused = true; }
    close() {
      const request = event();
      this.emit("close", request);
      if (!request.prevented) this.destroy();
      return request;
    }
    destroy() { this.destroyed = true; this.visible = false; this.emit("closed"); }
  }
  class Tray extends EventEmitter {
    destroyed = false;
    constructor() {
      super();
      if (failure === "create") throw new Error("Tray unavailable");
      trays.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    setToolTip() {}
    setContextMenu(menu) {
      if (failure === "menu") throw new Error("Tray menu unavailable");
      this.menu = menu;
    }
  }
  const image = { isEmpty: () => failure === "image", resize: () => image };
  const createWindow = () => {
    const window = new Window();
    windows.push(window);
    controller.attachWindow(window);
    return window;
  };
  const controller = createTrayController({
    app, Tray, nativeImage: { createFromPath: () => image }, iconPath: "cleo.png",
    Menu: { buildFromTemplate: items => items }, platform, canOpen, createWindow,
    onError: error => errors.push(error),
    onOpenMemory: window => memory.push({ window, visible: window.isVisible() }),
  });
  controller.start();
  const window = createWindow();
  const click = label => trays[0].menu.find(item => item.label === label).click();
  return { app, controller, window, windows, trays, errors, memory, click };
}

test("closing hides the live main window and tray or activation restores that same window", () => {
  const f = fixture();
  assert.equal(f.window.close().prevented, true);
  assert.equal(f.controller.isVisible(), false);
  assert.equal(f.window.isDestroyed(), false);
  assert.equal(f.app.quitCalls, 0);
  f.window.minimized = true;
  f.click("打开 Cleo");
  assert.equal(f.window.isVisible(), true);
  assert.equal(f.window.isMinimized(), false);
  assert.equal(f.window.focused, true);
  f.window.hide();
  f.trays[0].emit("click");
  assert.equal(f.window.isVisible(), true);
  f.window.hide();
  f.app.emit("activate");
  assert.equal(f.window.isVisible(), true);
  assert.equal(f.windows.length, 1);
});

test("memory management opens the window before delivering navigation", () => {
  const f = fixture();
  f.window.close();
  f.click("记忆管理");
  assert.deepEqual(f.memory, [{ window: f.window, visible: true }]);
});

test("tray quit waits for all application writers and then closes the window and tray", async () => {
  const f = fixture();
  const writer = Promise.withResolvers();
  let closes = 0;
  f.app.on("before-quit", createQuitBarrier({
    close: [() => { closes++; return writer.promise; }],
    onError: assert.fail, quit: () => f.app.quit(),
  }));
  const finished = new Promise(resolve => f.app.once("will-quit", resolve));
  f.window.hide();
  f.click("退出 Cleo");
  assert.equal(f.controller.isQuitting(), true);
  assert.equal(closes, 1);
  assert.equal(f.window.isDestroyed(), false);
  f.click("打开 Cleo");
  f.app.emit("activate");
  assert.equal(f.window.isVisible(), false);
  writer.resolve();
  await finished;
  assert.equal(closes, 1);
  assert.equal(f.window.isDestroyed(), true);
  assert.equal(f.trays[0].isDestroyed(), true);
});

test("application quit used by updates is never converted into hiding", () => {
  const f = fixture();
  f.app.quit();
  assert.equal(f.window.isDestroyed(), true);
  assert.equal(f.trays[0].isDestroyed(), true);
});

for (const platform of ["win32", "linux"]) for (const failure of ["image", "create", "menu"]) {
  test(`${platform} tray ${failure} failure preserves normal window close and application exit`, () => {
    const f = fixture({ platform, failure });
    assert.equal(f.errors.length, 1);
    assert.equal(f.window.close().prevented, false);
    f.app.emit("window-all-closed");
    assert.equal(f.app.quitCalls, 1);
    assert.ok(f.trays.every(tray => tray.isDestroyed()));
  });
}

test("macOS without a tray keeps normal application-menu and dock lifecycle", () => {
  const f = fixture({ platform: "darwin", failure: "create" });
  f.window.close();
  f.app.emit("window-all-closed");
  assert.equal(f.app.quitCalls, 0);
  f.app.emit("activate");
  assert.equal(f.windows.length, 2);
  assert.equal(f.controller.getWindow(), f.windows[1]);
});

test("Windows session shutdown begins cleanup without preventing the session-end event", () => {
  const f = fixture();
  const request = event();
  f.window.emit("query-session-end", request);
  assert.equal(request.prevented, false);
  assert.equal(f.app.quitCalls, 1);
  assert.equal(f.window.isDestroyed(), true);
});

test("a destroyed window can be recreated and repeated startup does not duplicate the tray", () => {
  const f = fixture();
  f.controller.start();
  assert.equal(f.trays.length, 1);
  f.window.destroy();
  f.click("打开 Cleo");
  assert.equal(f.windows.length, 2);
  assert.equal(f.controller.getWindow(), f.windows[1]);
});

test("restart preparation prevents opening or memory navigation", () => {
  const f = fixture({ canOpen: () => false });
  f.window.hide();
  f.click("打开 Cleo");
  f.click("记忆管理");
  assert.equal(f.window.isVisible(), false);
  assert.equal(f.memory.length, 0);
});
