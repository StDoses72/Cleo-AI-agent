import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ComputerBroker } from "./broker.mjs";
import { normalizeAddress } from "./browser.mjs";
import { parseShortcut, stopAccelerator } from "./keys.mjs";

class FakeBrowser extends EventEmitter {
  constructor() {
    super();
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
  createTab() { const id = `t${this.next++}`; const tab = { id, wc: { getZoomFactor: () => 1 } }; this.tabs.set(id, tab); this.order.push(id); this.activeId = id; this.emit("tabs"); return tab; }
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
  state() { return { tabs: this.order.map(id => ({ id, title: "", url: "https://example.com/" })), activeTabId: this.activeId }; }
}

function setup({ platform = "win32", owner = null, scope = "" } = {}) {
  const browser = new FakeBrowser();
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
  const broker = new ComputerBroker({ browser, host, backend, platform, protectedPids: [42] });
  return { broker, browser, host, hostCalls, backendCalls };
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

test("a second task cannot drive the computer while the first task runs", async () => {
  const { broker } = setup();
  broker.turnStarted("thread-a");
  await screenshot(broker);
  await assert.rejects(broker.call({ thread_id: "thread-b" }, "browser_screenshot", {}), /另一个 Cleo 任务/);
  broker.turnEnded("thread-a");
  await broker.call({ thread_id: "thread-b" }, "browser_screenshot", {});
});

test("tool identity comes from the harness client key", async () => {
  const known = setup({ owner: "thread-k" });
  const key = { client_key: "a".repeat(32) };
  await known.broker.call(key, "browser_screenshot", {});
  await known.broker.call(key, "browser_screenshot", {});
  assert.equal(known.backendCalls.filter(([method]) => method === "computer_owner").length, 1, "owner lookups are cached");
  assert.equal(known.broker.lease.threadId, "thread-k");
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
  broker.queues.browser.idle = async () => {};
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
