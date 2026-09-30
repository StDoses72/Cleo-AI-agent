import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CleoBrowser } from "./browser.mjs";

function setup() {
  const browser = new CleoBrowser({ electron: {} });
  const debug = new EventEmitter();
  let attached = false;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const methods = [];
  debug.isAttached = () => attached;
  debug.attach = () => { attached = true; };
  debug.detach = () => { attached = false; debug.emit("detach"); };
  debug.sendCommand = async method => { methods.push(method); if (method === "Page.enable") await blocked; };
  const tab = { id: "t1", wc: { debugger: debug, isDestroyed: () => false },
    attached: false, initialLoad: Promise.resolve(), attachPromise: null };
  browser.tabs.set(tab.id, tab);
  return { browser, tab, debug, methods, release };
}

test("unresponsive initialization times out and allows a fresh attachment", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { browser, tab, debug, release } = setup();
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
  const { browser, tab, methods, release } = setup();
  const abort = new AbortController();
  const pending = browser.capture(tab.id, abort.signal);
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
