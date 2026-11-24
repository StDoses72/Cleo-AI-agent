/* Cleo browser extension (Manifest V3 service worker).
 *
 * Connects to the Cleo desktop app through native messaging and lets it work in tabs of this
 * browser with the DevTools protocol (chrome.debugger): screenshots, mouse, keyboard and text
 * are page-level events, so the real pointer, window focus and clipboard are never touched and
 * the user's visible tab never changes. Which websites may be touched is decided in Cleo, which
 * asks the user per site; this extension only executes and reports. Tabs Cleo opens are put in
 * a "Cleo" tab group, and Cleo can close only those.
 */

const HOST = "ai.cleo.browser";
const GROUP_TITLE = "Cleo";
const INPUT_BINDING = "__cleoUserInput";
// The watcher lives in its own JavaScript world: page scripts can neither call the binding nor
// tamper with the listeners. Frames inside the page are not watched.
const WATCH_WORLD = "cleo-input-watch";
// Trusted-looking input events that Cleo itself dispatched; the page sees them as real input.
const OWN_INPUT_MS = 600;
const FORWARDED_EVENTS = new Set(["Page.javascriptDialogOpening", "Page.javascriptDialogClosed", "Page.loadEventFired"]);
const WATCH_SCRIPT = `(() => {
  if (window.${INPUT_BINDING}Installed) return;
  window.${INPUT_BINDING}Installed = true;
  const send = kind => { try { window.${INPUT_BINDING}(kind); } catch {} };
  addEventListener("pointerdown", event => { if (event.isTrusted) send("pointer"); }, true);
  addEventListener("keydown", event => { if (event.isTrusted) send("key"); }, true);
})()`;

let port = null;
let retry = null;
const attached = new Set();
const ownInputUntil = new Map();

function browserKind() {
  const brands = (navigator.userAgentData?.brands || []).map(item => item.brand);
  if (brands.some(brand => /Edge/i.test(brand))) return "edge";
  if (brands.some(brand => /Brave/i.test(brand))) return "brave";
  if (brands.some(brand => /Google Chrome/i.test(brand))) return "chrome";
  return "chromium";
}

function browserVersion() {
  const brand = (navigator.userAgentData?.brands || []).find(item => /Chrome|Edge|Brave/i.test(item.brand));
  return brand?.version || "";
}

function post(message) {
  try { port?.postMessage(message); } catch { /* The host went away; onDisconnect reconnects. */ }
}

function connect() {
  if (port) return;
  clearTimeout(retry);
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch {
    port = null;
    return;
  }
  port.onMessage.addListener(message => { void receive(message); });
  port.onDisconnect.addListener(() => {
    port = null;
    void detachAll();
    // The host waits for Cleo itself, so a disconnect means Chrome or the host stopped: retry later.
    retry = setTimeout(connect, 30_000);
  });
  post({ type: "hello", browser: browserKind(), version: browserVersion(), extension: chrome.runtime.getManifest().version });
}

async function cleoGroups(windowId) {
  const groups = await chrome.tabGroups.query(windowId === undefined ? {} : { windowId });
  return new Set(groups.filter(group => group.title === GROUP_TITLE).map(group => group.id));
}

function tabInfo(tab, groups) {
  return { id: tab.id, windowId: tab.windowId, title: tab.title || "", url: tab.url || tab.pendingUrl || "",
    active: Boolean(tab.active), status: tab.status || "", cleo: groups.has(tab.groupId) };
}

async function listTabs() {
  const groups = await cleoGroups();
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  return windows.map(item => ({ id: item.id, focused: item.focused, tabs: (item.tabs || []).map(tab => tabInfo(tab, groups)) }));
}

async function createTab({ url, windowId }) {
  const target = windowId ?? (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
  // Opened in the background: the tab the user is looking at stays in front.
  const tab = await chrome.tabs.create({ url: url || "about:blank", active: false, windowId: target });
  const existing = [...await cleoGroups(target)][0];
  if (existing !== undefined) {
    await chrome.tabs.group({ tabIds: [tab.id], groupId: existing });
  } else {
    const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: target } });
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "blue", collapsed: false });
  }
  return tabInfo(await chrome.tabs.get(tab.id), await cleoGroups(target));
}

async function closeTab({ tabId }) {
  const tab = await chrome.tabs.get(tabId);
  if (!(await cleoGroups(tab.windowId)).has(tab.groupId)) throw new Error("Only tabs Cleo opened can be closed.");
  await chrome.tabs.remove(tabId);
}

async function attach({ tabId }) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attached.add(tabId);
  const target = { tabId };
  await chrome.debugger.sendCommand(target, "Page.enable");
  await chrome.debugger.sendCommand(target, "Runtime.enable");
  await chrome.debugger.sendCommand(target, "Runtime.addBinding", { name: INPUT_BINDING, executionContextName: WATCH_WORLD });
  await chrome.debugger.sendCommand(target, "Page.addScriptToEvaluateOnNewDocument", { source: WATCH_SCRIPT, worldName: WATCH_WORLD });
  const { frameTree } = await chrome.debugger.sendCommand(target, "Page.getFrameTree");
  const { executionContextId } = await chrome.debugger.sendCommand(target, "Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: WATCH_WORLD });
  await chrome.debugger.sendCommand(target, "Runtime.evaluate", { expression: WATCH_SCRIPT, contextId: executionContextId });
}

async function detach({ tabId }) {
  if (!attached.delete(tabId)) return;
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

async function detachAll() {
  for (const tabId of [...attached]) await detach({ tabId });
}

async function send({ tabId, method, params }) {
  if (!attached.has(tabId)) await attach({ tabId });
  const input = method.startsWith("Input.");
  if (input) ownInputUntil.set(tabId, Date.now() + 5_000);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params || {});
  } finally {
    if (input) ownInputUntil.set(tabId, Date.now() + OWN_INPUT_MS);
  }
}

const OPERATIONS = {
  "tabs.list": listTabs,
  "tabs.create": createTab,
  "tabs.close": closeTab,
  "debugger.attach": attach,
  "debugger.detach": detach,
  "debugger.detachAll": detachAll,
  "debugger.send": send,
};

async function receive(message) {
  // Cleo went away (quit, crashed or turned this browser down): stop debugging every tab.
  if (message?.type === "status" && message.cleo === false) { await detachAll(); return; }
  if (message?.type !== "request") return;
  const operation = OPERATIONS[message.op];
  try {
    if (!operation) throw new Error(`Unknown operation ${message.op}`);
    post({ type: "response", id: message.id, ok: true, result: await operation(message.params || {}) ?? null });
  } catch (error) {
    post({ type: "response", id: message.id, ok: false, error: String(error?.message || error) });
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!attached.has(tabId)) return;
  if (method === "Runtime.bindingCalled") {
    if (params?.name !== INPUT_BINDING || Date.now() < (ownInputUntil.get(tabId) || 0)) return;
    post({ type: "event", event: "user.input", params: { tabId, kind: params.payload } });
  } else if (FORWARDED_EVENTS.has(method)) {
    post({ type: "event", event: "debugger.event", params: { tabId, method, params } });
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!attached.delete(source.tabId)) return;
  post({ type: "event", event: "debugger.detached", params: { tabId: source.tabId, reason } });
});

chrome.tabs.onRemoved.addListener(tabId => {
  attached.delete(tabId);
  post({ type: "event", event: "tab.removed", params: { tabId } });
});

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (!("title" in change) && !("url" in change) && !("status" in change)) return;
  post({ type: "event", event: "tab.updated", params: tabInfo(tab, await cleoGroups(tab.windowId)) });
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  post({ type: "event", event: "tab.activated", params: { tabId, windowId } });
});

chrome.alarms.create("cleo-connect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "cleo-connect") connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
