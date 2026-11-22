/** UI smoke for the computer page, its requests in the conversation, the computer settings page
 * and the files sidebar, with a scripted desktop bridge. The page shows only the mode the agent
 * is using; there is no mode switch for the user. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({ root: ui, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
let browser;

const step = (name, status = "done", detail = "") => ({ id: `${name}-${status}-${detail}`, name, detail, status, seconds: 0.4 });
const segment = (mode, steps, extra = {}) => ({ id: `seg-${mode}`, mode, startedAt: 0, endedAt: null, target: "", timing: { think: 2, tool: 1, wait: 0.5 },
  steps, stepCount: steps.length, ...extra });

function baseState(overrides = {}) {
  return {
    platform: "win32", hostSupported: true, lease: { threadId: "fixture", running: true },
    threads: { fixture: { mode: "browser", hostAuthorized: false, running: true, browserControl: "agent", userControl: "agent", userAlert: null, userTarget: null,
      activity: { segments: [segment("browser", [step("browser_screenshot"), step("browser_click", "running")])], phase: "acting", current: "browser_click", failure: null } } },
    control: { browser: "agent", user: "agent", desktop: "agent" }, inflight: [], authorization: null, siteRequests: [], sites: ["github.com"], stopping: false, lastStop: null,
    hostEngaged: false, browserEngaged: true, stopShortcut: "Control+Alt+Escape", shortcutActive: false, shortcutError: "", bridgeError: "",
    userBrowser: { connected: false, browser: null },
    userBrowserSetup: { browsers: [{ kind: "chrome", name: "Chrome", installed: true }, { kind: "edge", name: "Microsoft Edge", installed: false }], prepared: false, disabled: false, extensionDir: "C:\\cleo\\browser-extension\\extension" },
    browser: { threadId: "fixture", tabs: [{ id: "t1", title: "示例", url: "https://example.com/", loading: false, canGoBack: true, canGoForward: false, zoom: 1,
      crashed: null, unresponsive: false, error: null, dialog: null, fileChooser: null }], activeTabId: "t1", size: { width: 800, height: 600 },
      visible: true, parked: false, downloads: [], notices: [], downloadsDir: "C:\\Users\\me\\Downloads\\Cleo", hibernated: null },
    ...overrides,
  };
}

function withThread(state, thread) {
  return { ...state, threads: { fixture: { ...state.threads.fixture, ...thread } } };
}

const userTabs = [
  { id: "11", windowId: 1, title: "Pull requests", url: "https://github.com/pulls", active: true, cleo: false },
  { id: "12", windowId: 1, title: "Issue #160", url: "https://github.com/x/issues/160", active: false, cleo: false },
  { id: "20", windowId: 2, title: "Managing labels", url: "https://docs.github.com/labels", active: false, cleo: true },
];

try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 820 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let state = baseState();
  const actions = [];
  await page.exposeFunction("testComputer", async (action, params) => {
    actions.push({ action, params });
    if (action === "takeover") state = { ...state, control: { ...state.control, [params.target]: "user" } };
    if (action === "handback") state = { ...state, control: { ...state.control, [params.target]: "agent" } };
    if (action === "stop") state = { ...state, lastStop: { at: Date.now(), source: "panel", threadId: "fixture", released: ["left"], cancelledRun: true, settled: true, hostError: null } };
    if (action === "authorize") state = { ...state, authorization: null };
    if (action === "site") state = { ...state, siteRequests: [] };
    if (action === "userTabs") return { ...state, userTabs };
    if (action === "userBrowser" && params.action === "connect") state = { ...state, userBrowserSetup: { ...state.userBrowserSetup, prepared: true } };
    if (action === "removeSite") state = { ...state, sites: state.sites.filter(host => host !== params.host) };
    return state;
  });
  await page.exposeFunction("testFiles", async (op, params) => {
    actions.push({ action: `files:${op}`, params });
    if (op === "list") return params.path === "" ? { entries: [{ name: "src", path: "src", kind: "directory" }, { name: "README.md", path: "README.md", kind: "file" },
      { name: "logo.png", path: "logo.png", kind: "file" }], truncated: false } : { entries: [{ name: "app.ts", path: "src/app.ts", kind: "file" }], truncated: false };
    if (params.path === "README.md") return { path: "README.md", size: 20, modified: 0, url: "cleo-file://root/README.md", kind: "markdown", text: "# 标题\n\n正文" };
    if (params.path === "logo.png") return { path: "logo.png", size: 20, modified: 0, url: "cleo-file://root/logo.png", kind: "image" };
    return { path: params.path, size: 30, modified: 0, url: "cleo-file://root/src/app.ts", kind: "text", text: "line one\nline two\nline three\nline four" };
  });
  await page.addInitScript(() => {
    const listeners = new Set();
    window.pushComputerState = next => { for (const listener of listeners) listener(next); };
    window.cleoDesktop = {
      computer: (action, params) => window.testComputer(action, params ?? {}),
      onComputerState: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      files: (op, params) => window.testFiles(op, params),
    };
  });
  await page.goto(`${server.resolvedUrls.local[0]}tests/fixtures/computer-panel.html`);
  const push = async next => { state = next; await page.evaluate(value => window.pushComputerState(value), next); };
  const head = page.getByTestId("computer-mode-head");

  // The built-in browser the agent is using: one header, no mode switch, the page itself.
  await head.getByText("内置浏览器").waitFor();
  assert.equal(await page.getByRole("radio").count(), 0, "there is no user-facing mode switch");
  await head.getByText("点击网页").waitFor();
  await page.getByRole("tab").getByText("示例").waitFor();
  const viewport = () => actions.filter(item => item.action === "viewport").at(-1)?.params.rect;
  /** Purpose: Await the panel's viewport report after changing modal visibility. */
  async function expectBrowserVisible(visible, message) {
    for (let attempt = 0; attempt < 20 && Boolean(viewport()) !== visible; attempt++) await page.waitForTimeout(100);
    if (visible) assert.ok(viewport(), message);
    else assert.equal(viewport(), null, message);
  }
  for (let attempt = 0; attempt < 20 && !viewport(); attempt++) await page.waitForTimeout(100);
  assert.ok(viewport() && viewport().width > 100, "the native browser must be placed over the panel");
  await page.getByLabel("地址栏").fill("localhost:5173");
  await page.getByLabel("地址栏").press("Enter");
  assert.deepEqual(actions.find(item => item.action === "browser" && item.params.action === "navigate")?.params, { threadId: "fixture", action: "navigate", tabId: "t1", url: "localhost:5173" });
  assert.equal(actions.find(item => item.action === "viewport")?.params.threadId, "fixture", "viewport reports name the shown conversation");

  // Settings keeps its real Modal mounted when closed, like the main application.
  assert.equal(await page.locator("dialog.settings-backdrop").getAttribute("open"), null);
  await page.getByRole("button", { name: "打开保留的设置" }).click();
  await expectBrowserVisible(false, "a visible retained settings dialog must hide the browser");
  await page.getByRole("button", { name: "关闭保留的设置" }).click();
  await expectBrowserVisible(true, "the browser returns while the closed settings dialog remains mounted");
  await page.evaluate(() => {
    const ancestor = document.createElement("div");
    ancestor.id = "visibility-fixture";
    ancestor.hidden = true;
    ancestor.innerHTML = '<div class="command-palette" style="width:100px;height:50px">overlay</div>';
    document.body.appendChild(ancestor);
  });
  await page.waitForTimeout(100);
  assert.ok(viewport(), "an overlay inside a hidden ancestor must not hide the browser");
  await page.evaluate(() => { document.getElementById("visibility-fixture").hidden = false; });
  await expectBrowserVisible(false, "revealing an ancestor must hide the browser for its visible overlay");
  await page.evaluate(() => document.getElementById("visibility-fixture").remove());
  await expectBrowserVisible(true, "removing the overlay restores the browser");
  await page.getByRole("button", { name: "切换对话框" }).click();
  await expectBrowserVisible(false, "open dialogs must hide the browser view");
  await page.getByRole("dialog", { name: "示例对话框" }).evaluate(dialog => dialog.removeAttribute("open"));
  await expectBrowserVisible(true, "the browser view returns after the dialog closes");

  // Take over and hand back.
  await page.getByRole("button", { name: "接管", exact: true }).click();
  await page.getByRole("button", { name: "交回 AI" }).click();
  assert.deepEqual(actions.filter(item => ["takeover", "handback"].includes(item.action)).map(item => item.params), [{ target: "browser", threadId: "fixture" }, { target: "browser", threadId: "fixture" }]);

  // The agent switched to the user's own browser: the page becomes that browser's target card.
  await push(withThread({ ...baseState(), userBrowser: { connected: true, browser: { kind: "chrome", name: "Chrome", version: "142", extension: "1.0.0" } } }, {
    mode: "user", userTarget: { id: "12", title: "Issue #160", url: "https://github.com/x/issues/160", windowId: 1 },
    activity: { segments: [segment("browser", [step("browser_screenshot")], { endedAt: 1 }), segment("user", [step("user_browser_click", "running")])], phase: "acting", current: "user_browser_click", failure: null } }));
  await head.getByText("你的浏览器").waitFor();
  await head.getByText("Chrome · 已连接").waitFor();
  await page.getByTestId("computer-user-target").getByText("Issue #160").waitFor();
  await expectBrowserVisible(false, "the built-in browser leaves the page while the agent works in the user's browser");
  await page.getByRole("button", { name: "更换" }).click();
  await page.getByRole("option", { name: /Managing labels/ }).waitFor();
  await page.getByText("窗口 2").waitFor();
  await page.getByRole("option", { name: /Pull requests/ }).click();
  assert.deepEqual(actions.find(item => item.action === "userTarget").params, { threadId: "fixture", tabId: "11" });
  await push(withThread(state, { userAlert: "closed", userTarget: null }));
  await page.getByText("目标标签页已关闭，AI 已停止").waitFor();
  await page.getByRole("button", { name: "接管", exact: true }).click();
  assert.deepEqual(actions.filter(item => item.action === "takeover").at(-1).params, { target: "user", threadId: "fixture" });

  // A website in the user's browser is approved in the conversation, not on the page.
  await push({ ...state, siteRequests: [{ id: "s1", threadId: "fixture", host: "github.com", title: "Issue #160", browser: "Chrome" }] });
  await page.getByTestId("computer-approval").getByText("允许 Cleo 在 Chrome 中读取和操作 github.com？").waitFor();
  await page.getByRole("button", { name: "始终允许此网站" }).click();
  assert.deepEqual(actions.find(item => item.action === "site").params, { id: "s1", choice: "always" });

  // The desktop: the page shows what the agent does, the stop shortcut and where time goes.
  await push(withThread({ ...baseState(), lease: { threadId: "fixture", running: true } }, { mode: "host", hostAuthorized: true,
    activity: { segments: [segment("host", [step("desktop_screenshot"), step("desktop_app", "running", "记事本")], { target: "记事本" })], phase: "acting", current: "desktop_app", failure: null } }));
  await head.getByText("本机电脑").waitFor();
  await head.getByText("打开或切换应用 · 记事本").waitFor();
  await page.getByTestId("computer-host").getByText("Control+Alt+Escape").waitFor();
  await page.getByTestId("computer-timing").getByText("思考 2.0s").waitFor();
  if (process.env.CLEO_SMOKE_OUTPUT) {
    await mkdir(process.env.CLEO_SMOKE_OUTPUT, { recursive: true });
    await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "computer-host-mode.png") });
  }

  // An AI request for the desktop is answered in the conversation.
  await push({ ...state, authorization: { id: "req1", threadId: "fixture", reason: "需要打开记事本" } });
  await page.getByTestId("computer-approval").getByText(/需要打开记事本/).waitFor();
  await page.getByTestId("computer-approval").getByRole("button", { name: "拒绝" }).click();
  assert.deepEqual(actions.find(item => item.action === "authorize").params, { id: "req1", granted: false });

  // Stop reports the confirmed result from the broker.
  await push({ ...state, lastStop: { at: Date.now(), source: "panel", threadId: "fixture", released: [], cancelledRun: false, settled: false, hostError: null } });
  await page.getByText(/正在停止电脑操作/).waitFor();
  assert.equal(await page.getByText(/^已停止/).count(), 0, "pending cleanup is never displayed as stopped");
  await page.getByRole("button", { name: "停止" }).click();
  await page.getByText(/已停止任务，释放了 1 个按键或按钮/).waitFor();

  // After the turn: a summary of what happened in which target.
  await push(withThread({ ...baseState(), browser: { ...baseState().browser, tabs: [], activeTabId: null } }, { running: false, mode: "browser",
    activity: { segments: [segment("browser", [step("browser_screenshot")], { endedAt: 1, target: "localhost:5173" }), segment("user", [step("user_browser_click"), step("user_browser_type")], { endedAt: 2, target: "Issue #160" }), segment("host", [step("desktop_type")], { endedAt: 3, target: "记事本" })], phase: "idle", current: null, failure: null } }));
  const summary = page.getByTestId("computer-summary");
  await summary.getByText("本次电脑操作").waitFor();
  await summary.getByText("3 段 · 11s").waitFor();
  await summary.getByText("Issue #160").waitFor();
  assert.equal(await page.getByTestId("computer-mode-head").count(), 0, "after the turn no mode is shown, only the summary");

  // A hibernated conversation explains itself and reopens its pages on request.
  await push(withThread(baseState({ browser: { ...baseState().browser, tabs: [], activeTabId: null, hibernated: { at: Date.now(), tabs: [{ url: "https://example.com/", title: "示例" }] } } }), { running: false, activity: { segments: [], phase: "idle", current: null, failure: null } }));
  await page.getByTestId("browser-hibernated").getByText("浏览器已休眠").waitFor();
  await page.getByRole("button", { name: "重新打开" }).click();
  assert.deepEqual(actions.filter(item => item.action === "browser").at(-1).params, { threadId: "fixture", action: "wake" });
  // Another conversation's browser never flashes through this panel.
  await push(baseState({ browser: { ...baseState().browser, threadId: "other" } }));
  await page.waitForFunction(() => document.querySelectorAll("[role=tab]").length === 0);
  await push(baseState());
  await page.getByRole("tab").getByText("示例").waitFor();

  // Settings → Computer use: connect a browser, see the steps, remove an allowed site.
  await page.getByRole("button", { name: "电脑操作设置" }).click();
  const settings = page.getByTestId("computer-settings");
  await settings.getByTestId("computer-browser-chrome").getByRole("button", { name: "连接" }).click();
  assert.deepEqual(actions.find(item => item.action === "userBrowser").params, { action: "connect", kind: "chrome" });
  await push({ ...state });
  await settings.getByTestId("computer-extension-steps").getByText("点「加载已解压的扩展程序」").waitFor();
  await settings.getByTestId("computer-browser-edge").getByText("未安装").waitFor();
  await settings.getByRole("button", { name: "移除" }).click();
  assert.deepEqual(actions.find(item => item.action === "removeSite").params, { host: "github.com" });
  await page.getByRole("button", { name: "电脑操作设置" }).click();

  // Files sidebar: tree, preview, markdown and a chat link reveal with the target line.
  await page.getByRole("button", { name: "README.md" }).click();
  await page.getByRole("heading", { name: "标题" }).waitFor();
  await page.getByRole("button", { name: "logo.png" }).click();
  assert.equal(await page.locator(".files-image img").getAttribute("src"), "cleo-file://root/logo.png");
  await page.getByRole("button", { name: "定位聊天链接" }).click();
  await page.locator(".files-code span.target").getByText("line three").waitFor();
  await page.getByRole("button", { name: "在内置浏览器中打开" }).click();
  assert.deepEqual(actions.find(item => item.action === "preview").params, { root: "C:\\work", path: "src/app.ts", threadId: null });
  assert.equal(await page.locator("html").getAttribute("data-browser"), "open");
  assert.deepEqual(errors, []);
  console.log("computer panel smoke passed");
} finally {
  await browser?.close();
  await server.close();
}
