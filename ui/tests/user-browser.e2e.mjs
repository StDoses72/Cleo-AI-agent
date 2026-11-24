/** End-to-end check of "your browser" mode in a real Chromium with the real Cleo extension.
 *
 * Loads electron/computer/extension unpacked, registers the native host for Chromium only (per
 * user, removed again at the end), starts Cleo's computer bridge, and drives a background tab
 * through the broker while another tab stays in front: list tabs, ask for the website, screenshot,
 * click and type, read the page, open a tab in the "Cleo" group, then real input on the target
 * tab takes control away from the agent. Needs a desktop session (the window is shown).
 *
 * Run: node tests/user-browser.e2e.mjs   (CLEO_TEST_BROWSER may name a Chromium executable)
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ComputerBridge } from "../electron/computer/bridge.mjs";
import { ComputerBroker, MemorySitePolicy } from "../electron/computer/broker.mjs";
import { UserBrowser } from "../electron/computer/user-browser.mjs";
import { NATIVE_HOST_NAME, UserBrowserSetup } from "../electron/computer/user-browser-setup.mjs";

const CHROMIUM_KEY = `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
const reg = join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
const run = (file, args) => new Promise((resolve, reject) => execFile(file, args, { windowsHide: true }, error => (error ? reject(error) : resolve())));
const until = async (check, label, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`timed out waiting for ${label}`);
};
const json = blocks => JSON.parse(blocks[0].text);

const page = `<!doctype html><title>Target form</title><body style="margin:0;font:16px sans-serif">
  <input id="name" style="position:absolute;left:40px;top:40px;width:260px;height:30px">
  <button id="go" style="position:absolute;left:40px;top:100px;width:120px;height:36px" onclick="this.textContent='clicked'">Go</button>
  <div id="keys"></div><script>addEventListener('keydown', e => document.getElementById('keys').textContent += e.key)</script></body>`;
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(request.url.startsWith("/front") ? "<!doctype html><title>Front</title><h1>The user is reading this</h1>" : page);
}).listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const root = await mkdtemp(join(tmpdir(), "cleo-ub-e2e-"));
const userBrowser = new UserBrowser();
const bridge = new ComputerBridge({ directory: join(root, "bridge"), protect: () => {}, handler: async () => [],
  onLink: (socket, request, rest) => userBrowser.accept(socket, request, rest) });
const backend = { calls: [], async request(method, params) { this.calls.push([method, params]); return null; } };
const fakeBrowser = { on() {}, forThread() { return {}; }, state: () => ({ tabs: [] }), releaseAll: async () => [], foregroundId: null };
const broker = new ComputerBroker({ browser: fakeBrowser, host: { call: async () => ({}), stop: async () => ({ stopped: true }) }, backend,
  userBrowser, sites: new MemorySitePolicy() });
let context;
try {
  await mkdir(join(root, "bridge"), { recursive: true });
  await bridge.start();
  // Register the host for Chromium only; Chrome and Edge registrations are left untouched.
  const setup = new UserBrowserSetup({ userData: root, bridgeDirectory: join(root, "bridge"),
    run: (file, args, options, done) => (args[1].includes("\\Chromium\\") ? execFile(file, args, options, done) : done(null)) });
  const { extensionDir } = await setup.prepare();
  context = await chromium.launchPersistentContext(join(root, "profile"), {
    headless: false, executablePath: process.env.CLEO_TEST_BROWSER, viewport: null,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, "--window-size=900,700", "--window-position=30,30"],
  });
  const target = await context.newPage();
  await target.goto(`${origin}/form`);
  const front = await context.newPage();
  await front.goto(`${origin}/front`);
  await front.bringToFront();
  await until(() => userBrowser.connected, "the extension to connect through the native host", 30000);
  console.log(`connected: ${userBrowser.name} ${userBrowser.info.version}, extension ${userBrowser.info.extension}`);

  const T = { thread_id: "e2e" };
  broker.turnStarted("e2e");
  await broker.call(T, "computer_mode", { target: "user_browser", reason: "e2e" });
  const tabs = json(await broker.call(T, "user_browser_tabs", { action: "list" })).tabs;
  const tab = tabs.find(item => item.url.startsWith(`${origin}/form`));
  assert.ok(tab, "the user's existing tab is listed");
  assert.equal(tab.showing, false, "the target is a background tab");

  // The page moves to another website while the user is being asked: the answer for the old
  // site does not cover the new one, and nothing is captured on its strength.
  const moving = broker.call(T, "user_browser_screenshot", { tab_id: tab.tab_id });
  await until(() => broker.state().siteRequests.length, "the website request");
  assert.equal(broker.state().siteRequests[0].host, "127.0.0.1");
  await target.goto(`http://localhost:${server.address().port}/form`);
  broker.answerSite(broker.state().siteRequests[0].id, "once");
  await until(() => broker.state().siteRequests[0]?.host === "localhost", "a request for the new website");
  broker.answerSite(broker.state().siteRequests[0].id, "deny");
  await assert.rejects(moving, /localhost/);
  await target.goto(`${origin}/form`);

  // Back on 127.0.0.1, which the user allowed once in this turn.
  const shot = json(await broker.call(T, "user_browser_screenshot", { tab_id: tab.tab_id })).screenshot;
  assert.ok(shot.width > 300 && shot.height > 200, `screenshot ${shot.width}x${shot.height}`);

  const read = json(await broker.call(T, "user_browser_read", { tab_id: tab.tab_id }));
  const button = read.elements.find(item => item.tag === "button");
  const input = read.elements.find(item => item.tag === "input");
  await broker.call(T, "user_browser_click", { tab_id: tab.tab_id, screenshot_id: read.screenshot_id, x: input.x, y: input.y });
  await broker.call(T, "user_browser_type", { tab_id: tab.tab_id, screenshot_id: read.screenshot_id, text: "你好 Cleo" });
  await broker.call(T, "user_browser_click", { tab_id: tab.tab_id, screenshot_id: read.screenshot_id, x: button.x, y: button.y });
  assert.equal(await target.evaluate(() => document.getElementById("name").value), "你好 Cleo");
  assert.equal(await target.evaluate(() => document.getElementById("go").textContent), "clicked");
  // Playwright's Chromium keeps background pages "visible", so ask the browser which tab is in front.
  await userBrowser.refreshTabs();
  assert.equal(userBrowser.tab(tab.tab_id).active, false, "the target stayed in the background");
  assert.equal(userBrowser.tabs().find(item => item.url.startsWith(`${origin}/front`)).active, true, "the user's tab stayed in front");
  assert.equal(broker.state().threads.e2e.userControl, "agent", "Cleo's own input is not mistaken for the user's");

  // A tab the agent opens goes into the "Cleo" group, in the background.
  const opened = json(await broker.call(T, "user_browser_tabs", { action: "open", url: `${origin}/docs` })).opened;
  await until(async () => { await userBrowser.refreshTabs(); return userBrowser.tab(opened.tab_id)?.cleo; }, "the Cleo tab group");
  assert.equal(userBrowser.tab(opened.tab_id).active, false, "the new tab opened in the background");
  assert.equal(userBrowser.tabs().find(item => item.url.startsWith(`${origin}/front`)).active, true);

  // The user clicking in the agent's target tab takes control away from the agent; opening the
  // docs tab made that the target, so work in the form tab again first.
  await broker.call(T, "user_browser_screenshot", { tab_id: tab.tab_id });
  await front.mouse.click(100, 100);
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(broker.state().threads.e2e.userControl, "agent", "input in another tab is the user's own business");
  await target.bringToFront();
  await target.mouse.click(200, 300);
  await until(() => broker.state().threads.e2e.userControl === "user", "the takeover");
  console.log("user browser e2e passed");
} finally {
  broker.turnEnded("e2e");
  await context?.close().catch(() => {});
  await bridge.close().catch(() => {});
  server.close();
  await run(reg, ["delete", CHROMIUM_KEY, "/f"]).catch(() => {});
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
