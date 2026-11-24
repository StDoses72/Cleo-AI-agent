import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ComputerBridge } from "./bridge.mjs";
import { findCleo, frame, readFrames, runHost } from "./native-host.mjs";
import { UserBrowser } from "./user-browser.mjs";
import { EXTENSION_ID, installedBrowsers } from "./user-browser-setup.mjs";
import manifest from "./extension/manifest.json" with { type: "json" };

const until = async (check, label) => {
  for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`timed out waiting for ${label}`);
};

test("native messaging frames survive partial reads", () => {
  const bytes = Buffer.concat([frame({ type: "hello", browser: "chrome" }), frame({ type: "event", event: "tab.removed", params: { tabId: 3 } })]);
  const first = readFrames(bytes.subarray(0, 7));
  assert.deepEqual(first.messages, []);
  const all = readFrames(bytes);
  assert.deepEqual(all.messages.map(message => message.type), ["hello", "event"]);
  assert.equal(all.rest.length, 0);
  const split = readFrames(bytes.subarray(0, bytes.length - 2));
  assert.equal(split.messages.length, 1);
  assert.equal(split.rest.length, bytes.length - 2 - frame({ type: "hello", browser: "chrome" }).length);
});

test("the host finds the newest running Cleo instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-host-find-"));
  try {
    const write = async (name, pid, seconds) => {
      const path = join(root, name);
      await writeFile(path, JSON.stringify({ version: 1, transport: "pipe", address: `pipe-${pid}`, token: "t", pid }));
      await utimes(path, seconds, seconds);
    };
    await write("link-1-aa.json", 1, 1000);
    await write("link-2-bb.json", 2, 2000);
    await write("link-3-cc.json", 3, 3000);
    await write("bridge-4-dd.json", 4, 4000);
    await writeFile(join(root, "notes.txt"), "ignored");
    assert.equal(findCleo(root, { isAlive: pid => pid !== 3 }).address, "pipe-2", "an exited instance is skipped; tool descriptors are not links");
    assert.equal(findCleo(join(root, "missing")), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the extension manifest pins the id the native host allows", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ["alarms", "debugger", "nativeMessaging", "tabGroups", "tabs"]);
  assert.ok(!manifest.host_permissions, "no website permissions: Cleo asks per site itself");
  assert.match(EXTENSION_ID, /^[a-p]{32}$/);
  assert.ok(Array.isArray(installedBrowsers({ platform: "win32", env: {}, exists: () => false })));
});

/** A stand-in for the extension on the other side of the native host. */
function fakeExtension(stdin, stdout) {
  const seen = [];
  const state = { width: 800, events: [] };
  let buffer = Buffer.alloc(0);
  const send = message => stdin.write(frame(message));
  const answer = request => {
    const { op, params } = request;
    if (op === "tabs.list") return [{ id: 1, focused: true, tabs: [
      { id: 11, windowId: 1, title: "Pull requests", url: "https://github.com/pulls", active: true, status: "complete", cleo: false },
      { id: 12, windowId: 1, title: "Issue #160", url: "https://github.com/x/issues/160", active: false, status: "complete", cleo: false },
    ] }];
    if (op === "tabs.create") return { id: 20, windowId: 1, title: "", url: params.url, active: false, status: "loading", cleo: true };
    if (op === "debugger.send") {
      seen.push([params.tabId, params.method, params.params]);
      if (params.method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: state.width, clientHeight: 600, scale: 1 } };
      if (params.method === "Page.captureScreenshot") return { data: Buffer.from("png").toString("base64") };
      if (params.method === "Runtime.evaluate" && params.params.expression === "location.href") return { result: { value: "https://github.com/x/issues/160" } };
      if (params.method === "Runtime.evaluate") return { result: { value: { title: "Issue", url: "https://github.com/x/issues/160", text: "hello", elements: [] } } };
      return {};
    }
    return null;
  };
  stdout.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    const parsed = readFrames(buffer);
    buffer = parsed.rest;
    for (const message of parsed.messages) {
      if (message.type === "request") send({ type: "response", id: message.id, ok: true, result: answer(message) });
      else state.events.push(message);
    }
  });
  return { send, seen, state };
}

test("Cleo drives a background tab of the user's browser through the native host", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-user-browser-"));
  const browser = new UserBrowser();
  const bridge = new ComputerBridge({ directory: root, protect: () => {}, handler: async () => [],
    onLink: (socket, request, rest) => browser.accept(socket, request, rest) });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const exits = [];
  try {
    await bridge.start();
    const host = runHost({ stdin, stdout, directory: root, exit: code => exits.push(code) });
    const extension = fakeExtension(stdin, stdout);
    const lost = [];
    const inputs = [];
    browser.on("lost", event => lost.push(event.reason));
    browser.on("user-input", event => inputs.push(event.tabId));
    extension.send({ type: "hello", browser: "edge", version: "142", extension: "1.0.0" });
    await until(() => browser.connected && browser.tabs().length === 2, "the link");
    assert.equal(browser.name, "Microsoft Edge");
    assert.equal(browser.tab("12").title, "Issue #160");

    const shot = await browser.capture("12");
    assert.deepEqual([shot.width, shot.height, shot.geometry], [800, 600, "1:800x600@1"]);
    assert.ok(extension.seen.some(([tabId, method]) => tabId === 12 && method === "Page.captureScreenshot"), "the tab is captured in place");
    await browser.click("12", 10, 20, { button: "left", clicks: 1 });
    const press = extension.seen.find(([, method, params]) => method === "Input.dispatchMouseEvent" && params.type === "mousePressed");
    assert.deepEqual([press[0], press[2].x, press[2].y], [12, 10, 20]);
    await browser.type("12", "你好");
    assert.ok(extension.seen.some(([, method, params]) => method === "Input.insertText" && params.text === "你好"), "text goes in without the clipboard");
    assert.ok(!extension.seen.some(([, method]) => /bringToFront|activate/i.test(method)), "the user's visible tab never changes");

    extension.state.width = 900;
    await assert.rejects(browser.click("12", 1, 1, {}), /可见区域或缩放已变化/);
    await browser.capture("12");
    extension.send({ type: "event", event: "debugger.event", params: { tabId: 12, method: "Page.javascriptDialogOpening", params: { type: "confirm", message: "Leave?" } } });
    await until(() => browser.tab("12").dialog, "the dialog");
    await assert.rejects(browser.click("12", 1, 1, {}), error => error.dialog === true);

    const opened = await browser.openTab("https://docs.github.com/");
    assert.equal(opened.cleo, true);
    extension.send({ type: "event", event: "user.input", params: { tabId: 12, kind: "pointer" } });
    extension.send({ type: "event", event: "debugger.detached", params: { tabId: 12, reason: "canceled_by_user" } });
    await until(() => inputs.length && lost.length, "browser events");
    assert.deepEqual(inputs, ["12"]);
    assert.deepEqual(lost, ["canceled_by_user"]);

    stdin.end();
    await until(() => !browser.connected, "the disconnect");
    assert.deepEqual(exits, [0], "the host exits when the browser closes the connection");
    assert.deepEqual(lost, ["canceled_by_user", "disconnected"]);
    host.close();
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a tool token cannot open a link, and a second browser does not replace the first", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-link-token-"));
  const accepted = [];
  const bridge = new ComputerBridge({ directory: root, protect: () => {}, handler: async () => [], onLink: (_socket, request) => accepted.push(request.hello) });
  try {
    await bridge.start();
    const { createConnection } = await import("node:net");
    const attempt = token => new Promise(resolve => {
      const socket = createConnection(bridge.address);
      let reply = "";
      socket.on("data", chunk => { reply += chunk; });
      socket.on("close", () => resolve(reply));
      socket.on("connect", () => socket.write(`${JSON.stringify({ token, op: "link", hello: { type: "hello" } })}\n`));
      setTimeout(() => socket.destroy(), 500);
    });
    assert.match(await attempt(bridge.token), /ok":false/);
    assert.equal(accepted.length, 0, "the tool token is refused for links");
    await attempt(bridge.linkToken);
    assert.equal(accepted.length, 1);
    assert.equal(findCleo(root).token, bridge.linkToken, "the host finds the link token, not the tool token");
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
  const browser = new UserBrowser();
  const sockets = [];
  const socket = () => { const item = { destroyed: false, on() {}, setEncoding() {}, write() {}, destroy() { this.destroyed = true; } }; sockets.push(item); return item; };
  browser.accept(socket(), { hello: { type: "hello", browser: "chrome" } });
  browser.accept(socket(), { hello: { type: "hello", browser: "edge" } });
  assert.equal(browser.name, "Chrome", "the browser linked first keeps the connection");
  assert.deepEqual(sockets.map(item => item.destroyed), [false, true]);
});

test("a disconnected user browser refuses new links", async () => {
  let enabled = false;
  const browser = new UserBrowser({ enabled: () => enabled });
  const destroyed = [];
  const socket = { on() {}, setEncoding() {}, write() {}, destroy() { destroyed.push(true); } };
  browser.accept(socket, { hello: { type: "hello", browser: "chrome" } });
  assert.equal(browser.connected, false);
  assert.equal(destroyed.length, 1);
  enabled = true;
  browser.accept(socket, { hello: { type: "hello", browser: "chrome" } });
  assert.equal(browser.connected, true);
});
