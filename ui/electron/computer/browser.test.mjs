import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { BROWSER_IDLE_MS, CleoBrowser, partitionFor } from "./browser.mjs";

/** A minimal Electron stand-in: enough surface for tabs, sessions, keeper windows and screenshots. */
function fakeElectron() {
  const sessions = new Map();
  const views = [];
  const windows = [];
  class FakeWebContents extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.url = "";
      this.title = "";
      this.zoom = 1;
      this.loaded = [];
      const debug = { attached: false };
      this.debugger = { isAttached: () => debug.attached, attach: () => { debug.attached = true; }, detach: () => { debug.attached = false; },
        sendCommand: async () => ({ data: Buffer.from("png").toString("base64") }), on: () => {} };
    }
    isDestroyed() { return this.destroyed; }
    setWindowOpenHandler() {}
    async loadURL(url) { this.url = url; this.loaded.push(url); }
    getURL() { return this.url; }
    getTitle() { return this.title; }
    isLoading() { return false; }
    get navigationHistory() { return { canGoBack: () => false, canGoForward: () => false }; }
    getZoomFactor() { return this.zoom; }
    setZoomFactor(value) { this.zoom = value; }
    reload() {}
    stop() {}
    close() { this.destroyed = true; this.emit("destroyed"); }
  }
  class FakeView {
    constructor({ webContents, webPreferences } = {}) {
      this.webContents = webContents ?? new FakeWebContents();
      this.partition = webPreferences?.session?.partition ?? null;
      this.bounds = null;
      this.visible = null;
      views.push(this);
    }
    setBackgroundColor() {}
    setBounds(bounds) { this.bounds = bounds; }
    setVisible(visible) { this.visible = visible; }
  }
  class FakeWindow {
    constructor(options = {}) {
      this.options = options;
      this.destroyed = false;
      this.children = new Set();
      this.contentView = { addChildView: view => this.children.add(view), removeChildView: view => this.children.delete(view) };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    setIgnoreMouseEvents() {}
    showInactive() {}
    setBounds() {}
    isMinimized() { return false; }
    isVisible() { return true; }
    on() {}
    once() {}
    getBounds() { return { x: 0, y: 0, width: 10, height: 10 }; }
  }
  const session = {
    fromPartition(name) {
      let entry = sessions.get(name);
      if (!entry) {
        entry = { partition: name, schemes: [], cleared: 0,
          setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {},
          webRequest: { onBeforeRequest() {} }, on() {},
          protocol: { handle: scheme => entry.schemes.push(scheme), isProtocolHandled: async () => false },
          cookies: { flushStore: async () => {} }, clearStorageData: async () => { entry.cleared += 1; } };
        sessions.set(name, entry);
      }
      return entry;
    },
  };
  const electron = {
    session, WebContentsView: FakeView, BrowserWindow: FakeWindow,
    screen: { on() {}, removeListener() {}, getDisplayMatching: () => ({ scaleFactor: 1 }) },
    nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 1280, height: 800 }), toPNG: () => Buffer.from("png"), resize() { return this; } }) },
  };
  return { electron, sessions, views, windows, FakeWindow };
}

function setup() {
  const clock = { now: 0 };
  const fake = fakeElectron();
  const browser = new CleoBrowser({ electron: fake.electron, now: () => clock.now });
  return { ...fake, browser, clock };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test("conversations, foreground changes and state reads create no WebContents or windows", () => {
  const { browser, views, windows } = setup();
  browser.forThread("thread-a");
  browser.forThread("thread-b");
  browser.setForeground("thread-a");
  browser.setForeground("thread-b");
  assert.equal(browser.state().threadId, "thread-b");
  assert.deepEqual(browser.state().tabs, []);
  assert.equal(views.length, 0);
  assert.equal(windows.length, 0);
  assert.equal(browser.forThread("thread-a").hibernated, null);
});

test("tabs, partitions, screenshots and the last-tab rule are per conversation", async () => {
  const { browser, views, sessions } = setup();
  const a = browser.forThread("thread-a");
  const b = browser.forThread("thread-b");
  browser.setForeground("thread-a");
  a.createTab({ url: "https://a.example/" });
  b.createTab({ url: "https://b.example/" });
  assert.equal(views[0].partition, partitionFor("persist:cleo-browser", "thread-a"));
  assert.equal(views[1].partition, partitionFor("persist:cleo-browser", "thread-b"));
  assert.notEqual(views[0].partition, views[1].partition);
  assert.ok(sessions.has(views[0].partition) && sessions.has(views[1].partition));
  assert.deepEqual(a.state().tabs.map(tab => tab.url), ["https://a.example/"]);
  assert.deepEqual(b.state().tabs.map(tab => tab.url), ["https://b.example/"]);
  assert.equal(browser.state().threadId, "thread-a");
  assert.deepEqual(browser.state().tabs.map(tab => tab.url), ["https://a.example/"]);
  // Both conversations number their own tabs; a screenshot of one never names the other.
  assert.equal(a.activeId, "t1");
  assert.equal(b.activeId, "t1");
  const shot = await b.capture("t1");
  assert.equal(shot.width, 1280);
  a.close("t1");
  assert.deepEqual(a.state().tabs, []);
  assert.equal(a.activeId, null);
  assert.equal(views.length, 2, "closing the last tab must not recreate a blank page");
  assert.deepEqual(b.state().tabs.map(tab => tab.url), ["https://b.example/"]);
  assert.throws(() => a.requireTab("t1"), /不存在|已关闭/);
});

test("the shown conversation's tabs sit in the main window and background ones in the keeper", () => {
  const { browser, windows, FakeWindow } = setup();
  const main = new FakeWindow();
  browser.attachWindow(main);
  browser.setForeground("thread-a");
  browser.setViewport({ x: 0, y: 0, width: 800, height: 600 });
  const a = browser.forThread("thread-a");
  const b = browser.forThread("thread-b");
  const tabA = a.createTab({ url: "https://a.example/" });
  const tabB = b.createTab({ url: "https://b.example/" });
  const keeper = windows.find(window => window !== main);
  assert.ok(main.children.has(tabA.view));
  assert.ok(keeper.children.has(tabB.view));
  assert.equal(tabA.view.visible, true);
  assert.equal(tabB.view.visible, true, "background pages keep painting for their own screenshots");
  browser.setForeground("thread-b");
  assert.ok(main.children.has(tabB.view));
  assert.ok(keeper.children.has(tabA.view));
  assert.equal(browser.state().threadId, "thread-b");
});

test("idle conversations are hibernated after ten minutes unless protected, and wake by URL", () => {
  const { browser, views, windows, clock, FakeWindow } = setup();
  const main = new FakeWindow();
  browser.attachWindow(main);
  const a = browser.forThread("thread-a");
  const b = browser.forThread("thread-b");
  a.createTab({ url: "https://a.example/one" });
  a.createTab({ url: "https://a.example/two" });
  a.activate("t1");
  b.createTab({ url: "https://b.example/" });
  browser.setForeground("thread-a");
  browser.setViewport({ x: 0, y: 0, width: 800, height: 600 });
  const geometryBefore = b.geometry;

  clock.now = BROWSER_IDLE_MS - 1000;
  assert.deepEqual(browser.reclaimIdle(), [], "nothing is released before the threshold");
  clock.now = BROWSER_IDLE_MS + 1000;
  assert.deepEqual(browser.reclaimIdle(threadId => threadId === "thread-b"), [], "in-flight work protects a conversation");
  assert.deepEqual(browser.reclaimIdle(), ["thread-b"], "the shown conversation is deferred while it is on screen");
  assert.equal(views[2].webContents.destroyed, true);
  assert.deepEqual(b.state().tabs, []);
  assert.deepEqual(b.hibernated.tabs.map(tab => tab.url), ["https://b.example/"]);
  assert.ok(b.geometry > geometryBefore, "old screenshot ids expire with the pages");
  assert.equal(browser.state().threads["thread-b"].hibernated, true);

  // A pending dialog keeps a conversation alive; leaving the shown page restarts its window.
  a.requireTab("t1").dialog = { type: "alert", message: "wait" };
  browser.setViewport(null);
  clock.now += BROWSER_IDLE_MS + 1000;
  assert.deepEqual(browser.reclaimIdle(), []);
  a.requireTab("t1").dialog = null;
  assert.deepEqual(browser.reclaimIdle(), ["thread-a"]);
  assert.equal(windows.filter(window => window !== main).every(window => window.destroyed), true, "the keeper goes with the last page");
  assert.deepEqual(a.hibernated.tabs.map(tab => tab.url), ["https://a.example/one", "https://a.example/two"]);

  // Waking reloads the saved addresses with fresh tab ids; old ids are gone.
  const restored = a.ensureTab();
  assert.equal(a.hibernated, null);
  assert.deepEqual(a.state().tabs.map(tab => tab.url), ["https://a.example/one", "https://a.example/two"]);
  assert.equal(restored.id, "t3");
  assert.equal(a.activeId, "t3", "the previously active tab is active again");
  assert.throws(() => a.requireTab("t1"), /不存在|已关闭/);
  assert.equal(b.wake(), true);
  assert.deepEqual(b.state().tabs.map(tab => tab.url), ["https://b.example/"]);
  assert.equal(b.wake(), false);
});

test("downloads in progress defer reclaim and the timer uses the busy callback", t => {
  const { browser, clock } = setup();
  const a = browser.forThread("thread-a");
  a.createTab({ url: "https://a.example/" });
  a.downloads.unshift({ id: "d1", state: "progressing" });
  clock.now = BROWSER_IDLE_MS + 1;
  assert.deepEqual(browser.reclaimIdle(), []);
  a.downloads[0].state = "completed";
  t.mock.timers.enable({ apis: ["setInterval"] });
  const busy = [];
  browser.startIdleReclaim({ busy: threadId => { busy.push(threadId); return false; }, intervalMs: 1000 });
  t.mock.timers.tick(1000);
  assert.deepEqual(busy, ["thread-a"]);
  assert.deepEqual(a.state().tabs, []);
  browser.stopIdleReclaim();
});

test("registered schemes reach sessions created later and deleted conversations clear their data", async () => {
  const { browser, sessions } = setup();
  browser.registerProtocol("cleo-file", () => {});
  const a = browser.forThread("thread-a");
  a.createTab({ url: "https://a.example/" });
  await tick();
  const partition = partitionFor("persist:cleo-browser", "thread-a");
  assert.deepEqual(sessions.get(partition).schemes, ["cleo-file"]);
  await browser.releaseThread("thread-a");
  assert.equal(browser.hasContext("thread-a"), false);
  assert.equal(sessions.get(partition).cleared, 1);
  assert.deepEqual(browser.state().threads, {});
});

test("deleting a conversation clears its persisted partition even when this process never opened its browser", async () => {
  const { browser, sessions } = setup();
  // Used in an earlier launch: no in-memory context at all.
  await browser.releaseThread("thread-old");
  assert.equal(sessions.get(partitionFor("persist:cleo-browser", "thread-old")).cleared, 1);
  // Selected in the panel but never configured: a context without a session.
  browser.setForeground("thread-shown");
  await browser.releaseThread("thread-shown");
  assert.equal(browser.hasContext("thread-shown"), false);
  assert.equal(sessions.get(partitionFor("persist:cleo-browser", "thread-shown")).cleared, 1);
  assert.equal(browser.foregroundId, null);
});

function attachSetup() {
  const browser = new CleoBrowser({ electron: {} });
  const context = browser.context("thread-a");
  const debug = new EventEmitter();
  let attached = false;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const methods = [];
  debug.isAttached = () => attached;
  debug.attach = () => { attached = true; };
  debug.detach = () => { attached = false; debug.emit("detach"); };
  debug.sendCommand = async method => { methods.push(method); if (method === "Page.enable") await blocked; };
  const tab = { id: "t1", context, wc: { debugger: debug, isDestroyed: () => false },
    attached: false, initialLoad: Promise.resolve(), attachPromise: null };
  context.tabs.set(tab.id, tab);
  return { browser, tab, debug, methods, release };
}

test("unresponsive initialization times out and allows a fresh attachment", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { browser, tab, debug, release } = attachSetup();
  const pending = browser.attach(tab);
  const rejected = assert.rejects(pending, /初始化超时/);
  await Promise.resolve();
  t.mock.timers.tick(8000);
  await rejected;
  assert.equal(debug.isAttached(), false);
  assert.equal(tab.attachPromise, null);
  assert.equal(tab.attached, false);
  release();
  await browser.attach(tab);
  assert.equal(tab.attached, true);
});

test("cancelling a screenshot during initialization clears it without sending capture commands", async () => {
  const { browser, tab, methods, release } = attachSetup();
  const abort = new AbortController();
  const pending = browser.forThread("thread-a").capture(tab.id, abort.signal);
  abort.abort(new Error("工具调用已取消"));
  const outcome = await Promise.race([
    pending.then(() => "completed", error => error.message),
    new Promise(resolve => setTimeout(() => resolve("still waiting"), 50)),
  ]);
  release();
  await pending.catch(() => {});
  assert.equal(outcome, "工具调用已取消");
  assert.equal(methods.includes("Page.captureScreenshot"), false);
});
