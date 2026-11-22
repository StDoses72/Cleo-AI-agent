import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ComputerBroker } from "./broker.mjs";
import { normalizeAddress } from "./browser.mjs";
import { parseShortcut, stopAccelerator } from "./keys.mjs";

/** One conversation's fake browser; the pool below hands them out per thread id. */
class FakeBrowser extends EventEmitter {
  constructor(threadId = "thread-a", pool = null) {
    super();
    this.threadId = threadId;
    this.pool = pool;
    this.tabs = new Map();
    this.order = [];
    this.activeId = null;
    this.geometry = 1;
    this.size = { width: 800, height: 600 };
    this.notices = [];
    this.actions = [];
    this.gate = null;
    this.next = 1;
  }
  requireTab(id) { const tab = this.tabs.get(id); if (!tab) throw new Error(`标签页 ${id} 不存在`); return tab; }
  createTab() { const id = `t${this.next++}`; const tab = { id, wc: { getZoomFactor: () => 1 } }; this.tabs.set(id, tab); this.order.push(id); this.activeId = id; (this.pool ?? this).emit("tabs"); return tab; }
  touch() { this.touched = (this.touched || 0) + 1; }
  wake() { return false; }
  ensureTab() { return this.activeId ? this.requireTab(this.activeId) : this.createTab(); }
  activate(id) { this.requireTab(id); if (this.activeId !== id) { this.activeId = id; this.geometry++; } }
  close(id) { this.tabs.delete(id); this.order = this.order.filter(item => item !== id); if (this.activeId === id) this.activeId = this.order.at(-1) || null; }
  async navigate(id, url) { this.actions.push(["navigate", id, normalizeAddress(url)]); return url; }
  async history(id, action) { this.actions.push(["history", id, action]); }
  async capture(id) { this.requireTab(id); return { png: Buffer.from("png"), width: this.size.width, height: this.size.height }; }
  async click(id, x, y, options) { if (this.gate) await this.gate; this.actions.push(["click", id, x, y, options.button]); }
  async move(id, x, y) { this.actions.push(["move", id, x, y]); }
  async drag(id, from, to) { this.actions.push(["drag", id, from, to]); }
  async scroll(id, x, y, dx, dy) { this.actions.push(["scroll", id, dx, dy]); }
  async type(id, text) { this.actions.push(["type", id, text]); }
  async keys(id, keys) { this.actions.push(["keys", id, keys]); }
  async releaseAll() { return ["left"]; }
  async pageText() { return { title: "t", text: "hello", elements: [] }; }
  async setFiles(id, paths) { this.actions.push(["files", id, paths]); }
  setZoom() { this.geometry++; }
  setAgentOverlay(value) { this.overlay = value; }
  tabState(tab) { return { id: tab.id, title: "", url: "https://example.com/", loading: false, zoom: 1, dialog: null, fileChooser: null, crashed: null, error: null }; }
  state() { return { threadId: this.threadId, tabs: this.order.map(id => ({ id, title: "", url: "https://example.com/" })), activeTabId: this.activeId }; }
}

/** The shared browser: per-conversation fakes plus the foreground the panel shows. */
class FakePool extends EventEmitter {
  constructor() { super(); this.threads = new Map(); this.foregroundId = null; this.overlay = false; }
  forThread(threadId) {
    let browser = this.threads.get(threadId);
    if (!browser) { browser = new FakeBrowser(threadId, this); this.threads.set(threadId, browser); }
    return browser;
  }
  setForeground(threadId) { if (this.foregroundId !== threadId) { this.foregroundId = threadId; this.emit("foreground", threadId); } }
  setAgentOverlay(value) { this.overlay = value; }
  async releaseAll() { const released = []; for (const browser of this.threads.values()) released.push(...await browser.releaseAll()); return released; }
  state() {
    const shown = this.foregroundId ? this.forThread(this.foregroundId) : null;
    return { ...(shown ? shown.state() : { threadId: null, tabs: [], activeTabId: null }), threads: {} };
  }
}

function setup({ platform = "win32", owner = null, scope = "", userBrowser = null, now } = {}) {
  const pool = new FakePool();
  pool.setForeground("thread-a");
  const browser = pool.forThread("thread-a");
  const hostCalls = [];
  const host = {
    result: null,
    async call(op, args) {
      hostCalls.push([op, args]);
      if (op === "screenshot") return { image: "aW1n", width: 1600, height: 900, transform: { x: -1920, y: 0, sx: 2.4, sy: 2.4 },
        displays: [], windows: [], cursor: null, display: 0, foreground: "Notepad", signature: "sig", baseline: { tick: 1 } };
      return this.result || { baseline: { tick: 2 } };
    },
    async stop() { hostCalls.push(["stop"]); return { stopped: true, released: ["key:0x11"] }; },
  };
  const backendCalls = [];
  const backend = { async request(method, params) {
    backendCalls.push([method, params]);
    if (method === "computer_owner") return owner;
    if (method === "computer_scope") return { cwd: scope };
    return null;
  } };
  const broker = new ComputerBroker({ browser: pool, host, backend, platform, protectedPids: [42], userBrowser, ...(now ? { now } : {}) });
  return { broker, browser, pool, host, hostCalls, backendCalls };
}

const T = { thread_id: "thread-a" };

test("ending a turn cancels its pending screenshot and clears the working state", async () => {
  const { broker, browser } = setup();
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  browser.capture = (_id, signal) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    started();
  });
  broker.turnStarted(T.thread_id);
  const pending = broker.call(T, "browser_screenshot", {});
  const rejected = assert.rejects(pending, /任务已结束/);
  await waiting;
  assert.equal(broker.state().inflight.length, 1);
  broker.turnEnded(T.thread_id);
  await rejected;
  assert.equal(broker.state().inflight.length, 0);
  assert.equal(broker.state().browserEngaged, false);
  assert.equal(broker.state().lease, null);
});
const text = blocks => blocks.map(block => block.text || "").join("\n");
const json = blocks => JSON.parse(blocks[0].text);

async function screenshot(broker) {
  const blocks = await broker.call(T, "browser_screenshot", {});
  const data = json(blocks);
  return { tab: data.target.tab_id, id: data.screenshot.screenshot_id, blocks };
}

test("catalog follows the task's mode and never offers desktop tools without authorization", async () => {
  const { broker } = setup();
  assert.match(text(await broker.catalog(T)), /browser_screenshot/);
  assert.doesNotMatch(text(await broker.catalog(T)), /desktop_click/);
  await assert.rejects(broker.call(T, "desktop_screenshot", {}), /内置浏览器/);
  await assert.rejects(broker.setMode("thread-a", "host"), /明确授权/);
  await broker.setMode("thread-a", "host", { confirmed: true });
  assert.match(text(await broker.catalog(T)), /desktop_click/);
  await assert.rejects(broker.call(T, "browser_screenshot", {}), /本机电脑/);
  const other = setup({ platform: "darwin" });
  await assert.rejects(other.broker.setMode("thread-a", "host", { confirmed: true }), /仅支持 Windows/);
});

test("browser input requires a current screenshot of the displayed tab", async () => {
  const { broker, browser } = setup();
  await assert.rejects(broker.call(T, "browser_click", { tab_id: "t1", screenshot_id: "b-missing", x: 1, y: 1 }), /screenshot_id 无效/);
  const shot = await screenshot(broker);
  assert.equal(shot.blocks[1].type, "image");
  await broker.call(T, "browser_click", { tab_id: shot.tab, screenshot_id: shot.id, x: 10, y: 20 });
  assert.deepEqual(browser.actions.at(-1), ["click", shot.tab, 10, 20, "left"]);
  await assert.rejects(broker.call(T, "browser_click", { tab_id: shot.tab, screenshot_id: shot.id, x: 800, y: 0 }), /x 必须/);
  browser.geometry++;
  await assert.rejects(broker.call(T, "browser_click", { tab_id: shot.tab, screenshot_id: shot.id, x: 1, y: 1 }), /过期/);
  const fresh = await screenshot(broker);
  browser.createTab();
  await assert.rejects(broker.call(T, "browser_click", { tab_id: fresh.tab, screenshot_id: fresh.id, x: 1, y: 1 }), /不是当前显示的标签页/);
  await assert.rejects(broker.call(T, "browser_click", { tab_id: "t2", screenshot_id: fresh.id, x: 1, y: 1 }), /不一致/);
});

test("takeover cancels queued input and handback never replays old coordinates", async () => {
  const { broker, browser } = setup();
  const shot = await screenshot(broker);
  let release;
  browser.gate = new Promise(resolve => { release = resolve; });
  const first = broker.call(T, "browser_click", { tab_id: shot.tab, screenshot_id: shot.id, x: 1, y: 1 });
  const queued = broker.call(T, "browser_click", { tab_id: shot.tab, screenshot_id: shot.id, x: 2, y: 2 });
  await new Promise(resolve => setImmediate(resolve));
  await broker.takeover("browser");
  release();
  await assert.rejects(queued, /用户已接管/);
  await first.catch(() => {});
  browser.gate = null;
  const waiting = broker.call(T, "browser_click", { tab_id: shot.tab, screenshot_id: shot.id, x: 3, y: 3 });
  await new Promise(resolve => setTimeout(resolve, 50));
  await broker.handback("browser");
  await assert.rejects(waiting, /交回控制/);
  assert.ok(!browser.actions.some(action => action[0] === "click" && action[2] === 3), "stale input must not run");
  await assert.rejects(broker.call(T, "browser_click", { tab_id: shot.tab, screenshot_id: shot.id, x: 1, y: 1 }), /控制权发生过转移/);
});

test("conversations drive their own browsers at the same time; control and screenshots stay apart", async () => {
  const { broker, browser, pool } = setup();
  broker.turnStarted("thread-a");
  broker.turnStarted("thread-b");
  const a = await screenshot(broker);
  const b = json(await broker.call({ thread_id: "thread-b" }, "browser_screenshot", {}));
  const other = pool.forThread("thread-b");
  assert.notEqual(other, browser);
  assert.equal(b.target.tab_id, "t1", "each conversation numbers its own tabs");
  assert.equal(browser.order.length, 1);
  assert.equal(other.order.length, 1);
  assert.equal(browser.touched, 1, "a tool call counts as use of that conversation's browser only");
  assert.equal(other.touched, 1);
  await assert.rejects(broker.call(T, "browser_click", { tab_id: a.tab, screenshot_id: b.screenshot.screenshot_id, x: 1, y: 1 }), /另一个任务/);
  // Taking over thread-b's browser leaves thread-a's AI control untouched.
  await broker.takeover("browser", "user", "thread-b");
  assert.equal(broker.state().control.browser, "agent", "the shown conversation (thread-a) is still driven by the AI");
  assert.equal(broker.state().threads["thread-b"].browserControl, "user");
  assert.equal(broker.state().browserEngaged, true);
  await broker.call(T, "browser_click", { tab_id: a.tab, screenshot_id: a.id, x: 1, y: 1 });
  assert.deepEqual(browser.actions.at(-1), ["click", a.tab, 1, 1, "left"]);
  const waiting = broker.call({ thread_id: "thread-b" }, "browser_click", { tab_id: "t1", screenshot_id: b.screenshot.screenshot_id, x: 1, y: 1 });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(broker.threadBusy("thread-b"), true, "a queued action waiting for control counts as busy");
  await broker.handback("browser", "thread-b");
  await assert.rejects(waiting, /交回控制/);
  assert.ok(!other.actions.some(action => action[0] === "click"), "thread-b's stale click never ran");
  broker.turnEnded("thread-a");
  assert.equal(broker.state().threads["thread-a"].browserActive, false);
  assert.equal(broker.state().threads["thread-b"].browserActive, true);
  assert.equal(broker.state().lease, null, "no shared lease: the shown conversation is idle");
  pool.setForeground("thread-b");
  assert.equal(broker.state().control.browser, "agent", "thread-b handed control back above");
  assert.deepEqual(broker.state().lease, { threadId: "thread-b", running: true });
});

test("a panel stop halts one conversation; the emergency shortcut halts every conversation", async () => {
  const { broker, browser, pool, backendCalls } = setup();
  const other = pool.forThread("thread-b");
  broker.turnStarted("thread-a");
  broker.turnStarted("thread-b");
  const a = await screenshot(broker);
  const b = json(await broker.call({ thread_id: "thread-b" }, "browser_screenshot", {}));
  let releaseA;
  browser.gate = new Promise(resolve => { releaseA = resolve; });
  let releaseB;
  other.gate = new Promise(resolve => { releaseB = resolve; });
  const clickA = broker.call(T, "browser_click", { tab_id: a.tab, screenshot_id: a.id, x: 1, y: 1 });
  const clickB = broker.call({ thread_id: "thread-b" }, "browser_click", { tab_id: "t1", screenshot_id: b.screenshot.screenshot_id, x: 2, y: 2 });
  const queuedB = broker.call({ thread_id: "thread-b" }, "browser_wait", { seconds: 1 });
  await new Promise(resolve => setImmediate(resolve));
  broker.queueFor("browser", "thread-b").idle = async () => {};
  const stopped = await broker.stop({ source: "panel", threadId: "thread-b" });
  await assert.rejects(queuedB, /用户已停止/);
  assert.equal(stopped.threadId, "thread-b");
  assert.equal(stopped.scoped, true);
  assert.equal(stopped.settled, false, "thread-b's click is still in flight");
  assert.deepEqual(backendCalls.filter(([method]) => method === "cancel_run").map(([, params]) => params), [{ thread_id: "thread-b" }]);
  assert.equal(broker.threadBusy("thread-a"), true, "thread-a's click keeps running");
  releaseA();
  await clickA;
  assert.deepEqual(browser.actions.at(-1), ["click", a.tab, 1, 1, "left"]);
  assert.equal(broker.state().lastStop.settled, false, "thread-a finishing does not settle thread-b's stop");
  releaseB();
  await clickB.catch(() => {});
  assert.equal(broker.state().lastStop.settled, true);
  const fresh = await screenshot(broker);
  let releaseFresh;
  browser.gate = new Promise(resolve => { releaseFresh = resolve; });
  const pendingA = broker.call(T, "browser_click", { tab_id: fresh.tab, screenshot_id: fresh.id, x: 3, y: 3 });
  const waitingA = broker.call(T, "browser_wait", { seconds: 1 });
  await new Promise(resolve => setImmediate(resolve));
  broker.queueFor("browser", "thread-a").idle = async () => {};
  const emergency = await broker.stop({ source: "shortcut", threadId: "thread-b" });
  await assert.rejects(waitingA, /紧急停止/, "the shortcut cancels every conversation's queued work");
  assert.equal(emergency.scoped, false);
  assert.equal(emergency.settled, false, "thread-a's click is still in flight");
  releaseFresh();
  await pendingA.catch(() => {});
  assert.equal(broker.state().lastStop.settled, true);
});

test("a panel stop of an authorized conversation leaves the desktop another conversation is driving alone", async () => {
  const { broker, hostCalls, backendCalls } = setup();
  broker.turnStarted("thread-a");
  broker.turnStarted("thread-b");
  await broker.setMode("thread-a", "host", { confirmed: true });
  await broker.setMode("thread-b", "host", { confirmed: true });
  await broker.call({ thread_id: "thread-b" }, "desktop_screenshot", {});
  assert.equal(broker.state().lease?.threadId, "thread-b", "thread-b owns the desktop");
  const before = hostCalls.filter(([op]) => op === "stop").length;
  const stopped = await broker.stop({ source: "panel", threadId: "thread-a" });
  assert.equal(stopped.scoped, true);
  assert.equal(hostCalls.filter(([op]) => op === "stop").length, before, "the desktop controller is not stopped for a bystander");
  assert.equal(broker.state().lease?.threadId, "thread-b", "thread-b keeps the desktop");
  assert.equal(broker.state().threads["thread-a"].mode, "browser", "thread-a's authorization is still revoked");
  assert.equal(broker.state().threads["thread-b"].mode, "host");
  assert.deepEqual(backendCalls.filter(([method]) => method === "cancel_run").map(([, params]) => params), [{ thread_id: "thread-a" }]);
  // Ending thread-b's turn gives up its desktop authorization and releases the controller.
  broker.turnEnded("thread-b");
  assert.equal(broker.state().threads["thread-b"].mode, "browser", "authorization belongs to the turn");
  const afterTurn = hostCalls.filter(([op]) => op === "stop").length;
  assert.equal(afterTurn, before + 1);
  // With the desktop free, stopping an authorized conversation still releases the controller.
  await broker.setMode("thread-a", "host", { confirmed: true });
  await broker.stop({ source: "panel", threadId: "thread-a" });
  assert.equal(hostCalls.filter(([op]) => op === "stop").length, afterTurn + 1);
});

test("a global stop cancels the run of every engaged conversation, not only the desktop owner", async () => {
  const { broker, pool, backendCalls } = setup();
  const other = pool.forThread("thread-b");
  broker.turnStarted("thread-a");
  broker.turnStarted("thread-b");
  broker.turnStarted("thread-c");
  await broker.setMode("thread-a", "host", { confirmed: true });
  await broker.call(T, "desktop_screenshot", {});
  assert.equal(broker.state().lease?.threadId, "thread-a", "thread-a holds the desktop lease");
  const b = json(await broker.call({ thread_id: "thread-b" }, "browser_screenshot", {}));
  let releaseB;
  other.gate = new Promise(resolve => { releaseB = resolve; });
  const clickB = broker.call({ thread_id: "thread-b" }, "browser_click", { tab_id: "t1", screenshot_id: b.screenshot.screenshot_id, x: 2, y: 2 });
  await new Promise(resolve => setImmediate(resolve));
  broker.queueFor("browser", "thread-b").idle = async () => {};
  const result = await broker.stop({ source: "shortcut" });
  assert.equal(result.scoped, false);
  const cancelled = backendCalls.filter(([method]) => method === "cancel_run").map(([, params]) => params.thread_id).sort();
  assert.deepEqual(cancelled, ["thread-a", "thread-b"], "the desktop owner and the browser conversation are both cancelled");
  assert.ok(!cancelled.includes("thread-c"), "a running conversation that never used the computer is left alone");
  releaseB();
  await clickB.catch(() => {});
  assert.equal(broker.state().lastStop.settled, true);
});

test("the agent overlay follows the conversation shown in the panel", async () => {
  const { broker, pool } = setup();
  broker.turnStarted("thread-a");
  await screenshot(broker);
  assert.equal(pool.overlay, true, "thread-a is shown and driven by the AI");
  pool.setForeground("thread-b");
  assert.equal(pool.overlay, false, "an idle conversation is not covered by thread-a's overlay");
  assert.equal(broker.state().browserEngaged, false);
  pool.setForeground("thread-a");
  assert.equal(pool.overlay, true);
  assert.equal(broker.state().browserEngaged, true);
});

test("in-flight browser work marks a conversation busy and forgetting it drops its state", async () => {
  const { broker, browser } = setup();
  const shot = await screenshot(broker);
  assert.equal(broker.threadBusy("thread-a"), false);
  let release;
  browser.gate = new Promise(resolve => { release = resolve; });
  const click = broker.call(T, "browser_click", { tab_id: shot.tab, screenshot_id: shot.id, x: 1, y: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(broker.threadBusy("thread-a"), true);
  release();
  await click;
  assert.equal(broker.threadBusy("thread-a"), false);
  broker.forgetThread("thread-a");
  assert.equal(broker.state().threads["thread-a"], undefined);
  await assert.rejects(broker.call(T, "browser_click", { tab_id: shot.tab, screenshot_id: shot.id, x: 1, y: 1 }), /screenshot_id 无效/);
});

test("tool identity comes from the harness client key", async () => {
  const known = setup({ owner: "thread-k" });
  const key = { client_key: "a".repeat(32) };
  await known.broker.call(key, "browser_screenshot", {});
  await known.broker.call(key, "browser_screenshot", {});
  assert.equal(known.backendCalls.filter(([method]) => method === "computer_owner").length, 1, "owner lookups are cached");
  assert.equal(known.broker.thread("thread-k").browserActive, true);
  assert.equal(known.broker.lease, null, "browser use takes no desktop lease");
  const unknown = setup({ owner: null });
  await assert.rejects(unknown.broker.call(key, "browser_screenshot", {}), /无法确定/);
  await assert.rejects(unknown.broker.call({ client_key: "../x" }, "browser_screenshot", {}), /任务标识/);
});

test("a newer screenshot expires older coordinates for the same task and target", async () => {
  const { broker } = setup();
  const old = await screenshot(broker);
  const latest = await screenshot(broker);
  await assert.rejects(broker.call(T, "browser_click", { screenshot_id: old.id, x: 1, y: 1 }), /过期|最新/);
  await broker.call(T, "browser_click", { screenshot_id: latest.id, x: 1, y: 1 });
  await broker.setMode("thread-a", "host", { confirmed: true });
  const previous = json(await broker.call(T, "desktop_screenshot", {})).screenshot.screenshot_id;
  const current = json(await broker.call(T, "desktop_screenshot", {})).screenshot.screenshot_id;
  await assert.rejects(broker.call(T, "desktop_click", { screenshot_id: previous, x: 1, y: 1 }), /过期|最新/);
  await broker.call(T, "desktop_click", { screenshot_id: current, x: 1, y: 1 });
});

test("browser_read supplies a real screenshot for its returned coordinates", async () => {
  const { broker, browser } = setup();
  let captures = 0;
  const capture = browser.capture.bind(browser);
  browser.capture = async id => { captures++; return capture(id); };
  const blocks = await broker.call(T, "browser_read", {});
  assert.equal(captures, 1);
  assert.ok(blocks.some(block => block.type === "image"));
  await broker.call(T, "browser_click", { screenshot_id: json(blocks).screenshot_id, x: 1, y: 1 });
});

test("an unfinished stop reports completion only after the last action returns", async () => {
  const { broker, browser } = setup();
  const shot = await screenshot(broker);
  let release;
  browser.gate = new Promise(resolve => { release = resolve; });
  const click = broker.call(T, "browser_click", { screenshot_id: shot.id, x: 1, y: 1 });
  await new Promise(resolve => setImmediate(resolve));
  broker.queueFor("browser", "thread-a").idle = async () => {};
  const stopping = await broker.stop();
  assert.equal(stopping.settled, false);
  release();
  await click;
  assert.equal(broker.state().lastStop.settled, true);
});

test("a failed host stop cannot be reported as settled", async () => {
  const { broker, host } = setup();
  await broker.setMode("thread-a", "host", { confirmed: true });
  host.stop = async () => { throw new Error("controller did not acknowledge stop"); };
  const stopped = await broker.stop();
  assert.equal(stopped.settled, false);
  assert.match(stopped.hostError, /did not acknowledge/);
});

test("a host stop timeout requires a fresh acknowledgement before reporting completion", async () => {
  const { broker, host } = setup();
  await broker.setMode("thread-a", "host", { confirmed: true });
  host.stop = async () => ({ stopped: true, settled: false, released: [] });
  assert.equal((await broker.stop()).settled, false);
  host.stop = async () => ({ stopped: true, settled: true, released: [] });
  assert.equal((await broker.stop()).settled, true);
});

test("stop cancels work, releases input, revokes host control and cancels the owning run", async () => {
  const { broker, hostCalls, backendCalls } = setup();
  broker.turnStarted("thread-a");
  await broker.setMode("thread-a", "host", { confirmed: true });
  await broker.call(T, "desktop_screenshot", {});
  const waiting = broker.call(T, "desktop_wait", { seconds: 10 });
  await new Promise(resolve => setTimeout(resolve, 20));
  const result = await broker.stop({ source: "shortcut" });
  await assert.rejects(waiting, /紧急停止/);
  assert.equal(result.settled, true);
  assert.deepEqual(result.released, ["left", "key:0x11"]);
  assert.equal(result.cancelledRun, true);
  assert.ok(hostCalls.some(([op]) => op === "stop"));
  assert.deepEqual(backendCalls.find(([method]) => method === "cancel_run"), ["cancel_run", { thread_id: "thread-a" }]);
  assert.equal(broker.state().threads["thread-a"].mode, "browser");
});

test("desktop actions convert screenshot pixels to physical coordinates and pause on user activity", async () => {
  const { broker, host, hostCalls } = setup();
  await broker.setMode("thread-a", "host", { confirmed: true });
  const shot = json(await broker.call(T, "desktop_screenshot", {}));
  const id = shot.screenshot.screenshot_id;
  await broker.call(T, "desktop_click", { screenshot_id: id, x: 100, y: 50 });
  const [, args] = hostCalls.find(([op]) => op === "click");
  assert.equal(args.x, -1920 + 240);
  assert.equal(args.y, 120);
  assert.equal(args.signature, "sig");
  assert.deepEqual(args.protected_pids, [42]);
  host.result = { user_activity: true };
  await assert.rejects(broker.call(T, "desktop_click", { screenshot_id: id, x: 1, y: 1 }), /检测到用户/);
  assert.equal(broker.state().control.desktop, "user");
});

test("screenshots are bound to their target and mode", async () => {
  const { broker } = setup();
  const shot = await screenshot(broker);
  await broker.setMode("thread-a", "host", { confirmed: true });
  await assert.rejects(broker.call(T, "desktop_click", { screenshot_id: shot.id, x: 1, y: 1 }), /来自内置浏览器/);
  const desktop = json(await broker.call(T, "desktop_screenshot", {})).screenshot.screenshot_id;
  await broker.setMode("thread-a", "browser");
  await assert.rejects(broker.call(T, "browser_click", { tab_id: shot.tab, screenshot_id: shot.id, x: 1, y: 1 }), /模式发生过切换/);
  await assert.rejects(broker.call(T, "browser_click", { tab_id: shot.tab, screenshot_id: desktop, x: 1, y: 1 }), /来自本机电脑/);
});

test("the model can only request local control; the user decides", async () => {
  const { broker } = setup();
  const asking = broker.call(T, "request_desktop_control", { reason: "需要打开记事本" });
  await new Promise(resolve => setImmediate(resolve));
  const pending = broker.state().authorization;
  assert.equal(pending.reason, "需要打开记事本");
  await assert.rejects(broker.answerAuthorization("wrong", true), /失效/);
  await broker.answerAuthorization(pending.id, false);
  assert.match(text(await asking), /拒绝/);
  assert.equal(broker.state().threads["thread-a"].mode, "browser");
  const again = broker.call(T, "request_desktop_control", { reason: "再次" });
  await new Promise(resolve => setImmediate(resolve));
  await broker.answerAuthorization(broker.state().authorization.id, true);
  assert.match(text(await again), /已授权/);
  assert.equal(broker.state().threads["thread-a"].mode, "host");
});

test("uploads are limited to the task workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-broker-"));
  await mkdir(join(root, "work"));
  await writeFile(join(root, "work", "a.txt"), "a");
  await writeFile(join(root, "secret.txt"), "s");
  const { broker, browser } = setup({ scope: join(root, "work") });
  const shot = await screenshot(broker);
  await broker.call(T, "browser_upload", { tab_id: shot.tab, paths: ["a.txt"] });
  assert.equal(browser.actions.at(-1)[0], "files");
  await assert.rejects(broker.call(T, "browser_upload", { tab_id: shot.tab, paths: [join(root, "secret.txt")] }), /工作目录/);
  await assert.rejects(broker.call(T, "browser_upload", { tab_id: shot.tab, paths: ["../secret.txt"] }), /工作目录/);
});

test("browser-level shortcuts and address rules", async () => {
  const { broker, browser } = setup();
  const shot = await screenshot(broker);
  await broker.call(T, "browser_key", { tab_id: shot.tab, screenshot_id: shot.id, keys: "ctrl+t" });
  assert.equal(browser.order.length, 2);
  await assert.rejects(broker.call(T, "browser_key", { tab_id: browser.activeId, screenshot_id: shot.id, keys: "ctrl+l" }), /不一致|browser_navigate/);
  assert.equal(normalizeAddress("localhost:5173"), "http://localhost:5173/");
  assert.equal(normalizeAddress("example.com/a"), "https://example.com/a");
  assert.match(normalizeAddress("天气 预报"), /^https:\/\/www\.bing\.com\/search\?q=/);
  assert.throws(() => normalizeAddress("file:///C:/Windows/win.ini"), /不支持/);
  assert.throws(() => normalizeAddress("javascript:alert(1)"), /不支持|无法识别/);
  assert.deepEqual(parseShortcut("ctrl+shift+Tab").modifiers, ["Control", "Shift"]);
  assert.equal(stopAccelerator("ctrl+alt+esc"), "Control+Alt+Escape");
  assert.throws(() => stopAccelerator("esc"), /至少需要两个修饰键/);
});

/** The user's own browser as the broker sees it through the extension. */
class FakeUserBrowser extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.name = "Chrome";
    this.list = [
      { id: "11", windowId: 1, title: "Pull requests", url: "https://github.com/pulls", active: true, cleo: false, loading: false, dialog: null },
      { id: "12", windowId: 1, title: "Issue #160", url: "https://github.com/x/issues/160", active: false, cleo: false, loading: false, dialog: null },
      { id: "13", windowId: 2, title: "Bank", url: "https://bank.example.org/", active: true, cleo: false, loading: false, dialog: null },
      { id: "14", windowId: 2, title: "Extensions", url: "chrome://extensions/", active: false, cleo: false, loading: false, dialog: null },
    ];
    this.actions = [];
    this.geo = {};
    this.detached = 0;
    this.gate = null;
  }
  tabs() { return this.list; }
  tab(id) { return this.list.find(tab => tab.id === String(id)) ?? null; }
  async refreshTabs() { return this.list; }
  async openTab(url) { const tab = { id: "20", windowId: 1, title: "", url, active: false, cleo: true, loading: true, dialog: null }; this.list.push(tab); return tab; }
  async closeTab(id) {
    if (!this.tab(id)?.cleo) throw new Error("only Cleo tabs");
    this.list = this.list.filter(tab => tab.id !== id);
    // Chrome reports the removal before the close request returns.
    this.emit("tab-removed", id);
  }
  async capture(id) { this.geo[id] ??= "800x600@1"; this.actions.push(["capture", id]); return { png: Buffer.from("png"), width: 800, height: 600, geometry: this.geo[id] }; }
  geometry(id) { return this.geo[id] ?? null; }
  async liveUrl(id) { return this.live?.[id] ?? this.tab(id)?.url ?? ""; }
  async click(id, x, y) { if (this.gate) await this.gate; this.actions.push(["click", id, x, y]); }
  async type(id, value) { this.actions.push(["type", id, value]); }
  async keys(id, keys) { this.actions.push(["keys", id, keys]); }
  async navigate(id, url) { this.actions.push(["navigate", id, url]); }
  async pageText() { return { title: "t", text: "hello", elements: [] }; }
  async releaseAll() { return []; }
  async detachAll() { this.detached++; }
  state() { return { connected: this.connected, browser: { kind: "chrome", name: "Chrome" } }; }
}

/** Wait until the broker asks the user about a website, then return that request. */
async function siteRequest(broker) {
  for (let attempt = 0; attempt < 50 && !broker.state().siteRequests.length; attempt++) await new Promise(resolve => setImmediate(resolve));
  return broker.state().siteRequests[0];
}

test("the agent picks the target with computer_mode; the desktop needs the user and the user's browser the extension", async () => {
  const user = new FakeUserBrowser();
  user.connected = false;
  const { broker } = setup({ userBrowser: user });
  broker.turnStarted("thread-a");
  assert.match(text(await broker.catalog(T)), /computer_mode/);
  assert.match(text(await broker.call(T, "computer_mode", { target: "user_browser", reason: "需要登录" })), /没有通过 Cleo 扩展连接/);
  assert.equal(broker.state().threads["thread-a"].mode, "browser");
  user.connected = true;
  await broker.call(T, "computer_mode", { target: "user_browser", reason: "需要登录" });
  assert.equal(broker.state().threads["thread-a"].mode, "user");
  const catalog = text(await broker.catalog(T));
  assert.match(catalog, /user_browser_screenshot/);
  assert.doesNotMatch(catalog, /"browser_click"/);
  await assert.rejects(broker.call(T, "browser_screenshot", {}), /当前目标是你的浏览器/);
  // The extension going away drops the conversation back to the built-in browser.
  user.connected = false;
  assert.equal(broker.state().threads["thread-a"].mode, "browser");
  user.connected = true;
  await broker.call(T, "computer_mode", { target: "builtin_browser", reason: "本地预览" });
  assert.equal(broker.state().threads["thread-a"].mode, "browser");
  const asking = broker.call(T, "computer_mode", { target: "desktop", reason: "需要记事本" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(broker.state().authorization.reason, "需要记事本");
  await broker.answerAuthorization(broker.state().authorization.id, true);
  assert.match(text(await asking), /已授权/);
  assert.equal(broker.state().threads["thread-a"].mode, "host");
  // Authorization and the chosen target belong to the turn.
  broker.turnEnded("thread-a");
  assert.equal(broker.state().threads["thread-a"].mode, "browser");
  assert.equal(broker.state().threads["thread-a"].hostAuthorized, false);
});

test("each website of the user's browser is approved before the agent reads it", async () => {
  const user = new FakeUserBrowser();
  const { broker } = setup({ userBrowser: user });
  broker.turnStarted("thread-a");
  await broker.setMode("thread-a", "user");
  const listed = json(await broker.call(T, "user_browser_tabs", { action: "list" }));
  assert.deepEqual(listed.tabs.map(tab => tab.tab_id), ["11", "12", "13", "14"], "listing tabs needs no website approval");
  const first = broker.call(T, "user_browser_screenshot", { tab_id: "12" });
  const request = await siteRequest(broker);
  assert.equal(request.host, "github.com");
  assert.equal(user.actions.length, 0, "nothing is captured before the user answers");
  broker.answerSite(request.id, "once");
  await first;
  await broker.call(T, "user_browser_screenshot", { tab_id: "11" });
  assert.equal(broker.state().siteRequests.length, 0, "once covers the rest of this turn");
  broker.turnEnded("thread-a");
  broker.turnStarted("thread-a");
  await broker.setMode("thread-a", "user");
  const again = broker.call(T, "user_browser_screenshot", { tab_id: "12" });
  broker.answerSite((await siteRequest(broker)).id, "always");
  await again;
  assert.deepEqual(broker.state().sites, ["github.com"]);
  const bank = broker.call(T, "user_browser_screenshot", { tab_id: "13" });
  broker.answerSite((await siteRequest(broker)).id, "deny");
  await assert.rejects(bank, /拒绝了 Cleo 访问 bank\.example\.org/);
  await assert.rejects(broker.call(T, "user_browser_screenshot", { tab_id: "14" }), /只支持 http 和 https/);
  // Navigating to a new website asks again; opening a tab goes into the Cleo group.
  const navigating = broker.call(T, "user_browser_navigate", { tab_id: "12", url: "docs.github.com/labels" });
  broker.answerSite((await siteRequest(broker)).id, "once");
  await navigating;
  assert.deepEqual(user.actions.at(-1), ["navigate", "12", "https://docs.github.com/labels"]);
  const opened = json(await broker.call(T, "user_browser_tabs", { action: "open" }));
  assert.equal(opened.opened.tab_id, "20");
  await assert.rejects(broker.call(T, "user_browser_tabs", { action: "close", tab_id: "11" }), /only Cleo tabs/);
});

test("user-browser input needs the latest screenshot of the same tab and viewport", async () => {
  const user = new FakeUserBrowser();
  const { broker } = setup({ userBrowser: user });
  broker.sites.allow("github.com");
  await broker.setMode("thread-a", "user");
  const shot = json(await broker.call(T, "user_browser_screenshot", { tab_id: "12" })).screenshot;
  assert.match(shot.screenshot_id, /^u-/);
  await broker.call(T, "user_browser_click", { tab_id: "12", screenshot_id: shot.screenshot_id, x: 10, y: 20 });
  assert.deepEqual(user.actions.at(-1), ["click", "12", 10, 20]);
  await assert.rejects(broker.call(T, "user_browser_click", { tab_id: "11", screenshot_id: shot.screenshot_id, x: 1, y: 1 }), /不一致/);
  user.geo["12"] = "900x600@1";
  await assert.rejects(broker.call(T, "user_browser_click", { tab_id: "12", screenshot_id: shot.screenshot_id, x: 1, y: 1 }), /可见区域或缩放已变化/);
  await broker.setMode("thread-a", "browser");
  await assert.rejects(broker.call(T, "browser_click", { tab_id: "t1", screenshot_id: shot.screenshot_id, x: 1, y: 1 }), /来自你的浏览器/);
});

test("closing the target tab stops the agent there; it must ask instead of picking another tab", async () => {
  const user = new FakeUserBrowser();
  const { broker } = setup({ userBrowser: user });
  broker.sites.allow("github.com");
  broker.turnStarted("thread-a");
  await broker.setMode("thread-a", "user");
  await broker.call(T, "user_browser_screenshot", { tab_id: "12" });
  assert.equal(broker.state().threads["thread-a"].userTarget.id, "12");
  user.list = user.list.filter(tab => tab.id !== "12");
  user.emit("tab-removed", "12");
  assert.equal(broker.state().threads["thread-a"].userAlert, "closed");
  await assert.rejects(broker.call(T, "user_browser_screenshot", { tab_id: "11" }), /不要自行改用其他标签页/);
  broker.pickUserTarget("thread-a", "11");
  const listed = json(await broker.call(T, "user_browser_tabs", { action: "list" }));
  assert.match(listed.user_choice, /11/);
  assert.equal(broker.state().threads["thread-a"].userAlert, null);
});

test("real input on the target tab hands control to the user; input elsewhere does not", async () => {
  const user = new FakeUserBrowser();
  const { broker, backendCalls } = setup({ userBrowser: user });
  broker.sites.allow("github.com");
  broker.turnStarted("thread-a");
  await broker.setMode("thread-a", "user");
  const shot = json(await broker.call(T, "user_browser_screenshot", { tab_id: "12" })).screenshot;
  await broker.userInputOnTab("11");
  assert.equal(broker.state().threads["thread-a"].userControl, "agent", "another tab is the user's own business");
  await broker.userInputOnTab("12");
  assert.equal(broker.state().threads["thread-a"].userControl, "user");
  assert.equal(broker.phaseOf("thread-a"), "paused");
  const waiting = broker.call(T, "user_browser_click", { tab_id: "12", screenshot_id: shot.screenshot_id, x: 1, y: 1 });
  await new Promise(resolve => setTimeout(resolve, 30));
  await broker.handback("user", "thread-a");
  await assert.rejects(waiting, /交回控制/);
  // Cancelling the browser's debugging bar revokes access and stops the run.
  user.emit("lost", { reason: "canceled_by_user" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(broker.state().threads["thread-a"].userAlert, "detached");
  assert.ok(backendCalls.some(([method, params]) => method === "cancel_run" && params.thread_id === "thread-a"));
  broker.turnEnded("thread-a");
  assert.ok(user.detached >= 1, "the debugger is released when no turn needs the browser");
});

test("the computer page gets per-mode segments, steps, timing and the current phase", async () => {
  let clock = 1000;
  const user = new FakeUserBrowser();
  const { broker, browser } = setup({ userBrowser: user, now: () => clock });
  broker.sites.allow("github.com");
  broker.turnStarted("thread-a");
  assert.equal(broker.phaseOf("thread-a"), "idle");
  await broker.call(T, "browser_screenshot", {});
  clock += 4000;
  await broker.call(T, "computer_mode", { target: "user_browser", reason: "登录" });
  clock += 2000;
  await broker.call(T, "user_browser_screenshot", { tab_id: "12" });
  let release;
  user.gate = new Promise(resolve => { release = resolve; });
  assert.equal(broker.state().threads["thread-a"].activity.phase, "thinking");
  const id = [...broker.observations.keys()].at(-1);
  const clicking = broker.call(T, "user_browser_click", { tab_id: "12", screenshot_id: id, x: 1, y: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(broker.phaseOf("thread-a"), "acting");
  clock += 500;
  release();
  await clicking;
  const { segments } = broker.state().threads["thread-a"].activity;
  assert.deepEqual(segments.map(segment => segment.mode), ["browser", "user"]);
  assert.deepEqual(segments[1].steps.map(step => step.name), ["user_browser_screenshot", "user_browser_click"]);
  assert.equal(segments[1].target, "Issue #160");
  assert.equal(segments[0].timing.think, 4, "thinking before the switch belongs to the segment it leaves");
  assert.equal(segments[1].timing.think, 2);
  assert.equal(segments[1].timing.tool, 0.5);
  assert.equal(browser.actions.length, 0);
  await assert.rejects(broker.call(T, "user_browser_click", { tab_id: "12", screenshot_id: "u-missing", x: 1, y: 1 }), /screenshot_id/);
  assert.equal(broker.phaseOf("thread-a"), "failed");
  broker.turnEnded("thread-a");
  assert.notEqual(broker.state().threads["thread-a"].activity.segments.at(-1).endedAt, null);
  broker.turnStarted("thread-a");
  assert.equal(broker.state().threads["thread-a"].activity.segments.length, 0, "a new turn reports only its own work");
});

test("review fixes: live address, own tab close, ended turns and lost browsers", async () => {
  const user = new FakeUserBrowser();
  const { broker } = setup({ userBrowser: user });
  broker.sites.allow("github.com");
  broker.turnStarted("thread-a");
  await broker.setMode("thread-a", "user");
  // The tab list still says github.com, but the page already redirected elsewhere: ask first.
  user.live = { 12: "https://evil.example.net/login" };
  const redirected = broker.call(T, "user_browser_screenshot", { tab_id: "12" });
  const request = await siteRequest(broker);
  assert.equal(request.host, "evil.example.net");
  broker.answerSite(request.id, "deny");
  await assert.rejects(redirected, /拒绝/);
  user.live = {};
  // Closing a tab the agent opened itself is not the user closing the target.
  const opened = json(await broker.call(T, "user_browser_tabs", { action: "open", url: "github.com/new" })).opened;
  await broker.call(T, "user_browser_tabs", { action: "close", tab_id: opened.tab_id });
  assert.equal(broker.state().threads["thread-a"].userAlert, null);
  await broker.call(T, "user_browser_screenshot", { tab_id: "12" });
  // A request still open when the turn ends is denied; a late answer grants nothing.
  const pending = broker.call(T, "user_browser_screenshot", { tab_id: "13" });
  const late = await siteRequest(broker);
  broker.turnEnded("thread-a");
  await assert.rejects(pending, /拒绝|结束/);
  assert.throws(() => broker.answerSite(late.id, "always"), /失效/);
  assert.deepEqual(broker.state().sites, ["github.com"]);
  // After the browser was lost, no call in that turn reaches it again.
  broker.turnStarted("thread-a");
  await broker.setMode("thread-a", "user");
  await broker.userBrowserLost("canceled_by_user");
  await assert.rejects(broker.call(T, "user_browser_screenshot", { tab_id: "12" }), /断开或被用户取消/);
});
