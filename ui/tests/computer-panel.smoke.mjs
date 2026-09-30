/** UI smoke for the computer panel and files sidebar with a scripted desktop bridge. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({ root: ui, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
let browser;

function baseState(overrides = {}) {
  return {
    platform: "win32", hostSupported: true, threads: {}, lease: { threadId: "fixture", running: true },
    control: { browser: "agent", desktop: "agent" }, inflight: [], authorization: null, stopping: false, lastStop: null,
    hostEngaged: false, browserEngaged: true, stopShortcut: "Control+Alt+Escape", shortcutActive: false, shortcutError: "", bridgeError: "",
    browser: { tabs: [{ id: "t1", title: "示例", url: "https://example.com/", loading: false, canGoBack: true, canGoForward: false, zoom: 1,
      crashed: null, unresponsive: false, error: null, dialog: null, fileChooser: null }], activeTabId: "t1", size: { width: 800, height: 600 },
      visible: true, parked: false, downloads: [], notices: [], downloadsDir: "C:\\Users\\me\\Downloads\\Cleo" },
    ...overrides,
  };
}

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
    if (action === "mode") state = baseState({ threads: { fixture: { mode: params.mode, hostAuthorized: params.mode === "host" } } });
    if (action === "takeover") state = { ...state, control: { ...state.control, [params.target]: "user" } };
    if (action === "handback") state = { ...state, control: { ...state.control, [params.target]: "agent" } };
    if (action === "stop") state = { ...state, lastStop: { at: Date.now(), source: "panel", threadId: "fixture", released: ["left"], cancelledRun: true, settled: true, hostError: null } };
    if (action === "authorize") state = { ...state, authorization: null };
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
    window.cleoDesktop = {
      computer: (action, params) => window.testComputer(action, params ?? {}),
      onComputerState: listener => { window.pushComputerState = listener; return () => {}; },
      files: (op, params) => window.testFiles(op, params),
    };
  });
  await page.goto(`${server.resolvedUrls.local[0]}tests/fixtures/computer-panel.html`);

  // Browser mode is the default: chrome, tabs and a viewport reported to the main process.
  await page.getByRole("radio", { name: "内置浏览器" }).waitFor();
  assert.equal(await page.getByRole("radio", { name: "内置浏览器" }).getAttribute("aria-checked"), "true");
  await page.getByRole("tab").getByText("示例").waitFor();
  await page.waitForFunction(() => true);
  const viewport = () => actions.filter(item => item.action === "viewport").at(-1)?.params.rect;
  /** Purpose: Await the panel's viewport report after changing modal visibility.
   * Input: Expected visibility and failure message. Output: The original strict viewport check.
   */
  async function expectBrowserVisible(visible, message) {
    for (let attempt = 0; attempt < 20 && Boolean(viewport()) !== visible; attempt++) {
      await page.waitForTimeout(100);
    }
    if (visible) assert.ok(viewport(), message);
    else assert.equal(viewport(), null, message);
  }
  for (let attempt = 0; attempt < 20 && !viewport(); attempt++) await page.waitForTimeout(100);
  assert.ok(viewport() && viewport().width > 100, "the native browser must be placed over the panel");
  await page.getByLabel("地址栏").fill("localhost:5173");
  await page.getByLabel("地址栏").press("Enter");
  assert.deepEqual(actions.find(item => item.action === "browser" && item.params.action === "navigate")?.params, { action: "navigate", tabId: "t1", url: "localhost:5173" });

  // Settings keeps its real Modal mounted when closed, like the main application.
  assert.equal(await page.locator("dialog.settings-backdrop").count(), 1);
  assert.equal(await page.locator("dialog.settings-backdrop").getAttribute("open"), null);
  await page.getByRole("button", { name: "打开保留的设置" }).click();
  await expectBrowserVisible(false, "a visible retained settings dialog must hide the browser");
  await page.getByRole("button", { name: "关闭保留的设置" }).click();
  await expectBrowserVisible(true, "the browser returns while the closed settings dialog remains mounted");

  // Hidden ancestors and CSS visibility changes must not become phantom open modals.
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
  await page.evaluate(() => { document.getElementById("visibility-fixture").style.visibility = "hidden"; });
  await expectBrowserVisible(true, "CSS visibility on an ancestor must restore the browser");
  await page.evaluate(() => { document.getElementById("visibility-fixture").style.visibility = "visible"; });
  await expectBrowserVisible(false, "restoring CSS visibility must hide the browser again");
  await page.evaluate(() => { document.getElementById("visibility-fixture").style.display = "none"; });
  await expectBrowserVisible(true, "a display:none ancestor must restore the browser");
  await page.evaluate(() => document.getElementById("visibility-fixture").remove());

  // Cleo's own dialogs hide the native browser instead of being covered by it.
  await page.getByRole("button", { name: "切换对话框" }).click();
  await expectBrowserVisible(false, "open dialogs must hide the browser view");
  await page.getByRole("dialog", { name: "示例对话框" }).evaluate(dialog => dialog.removeAttribute("open"));
  await expectBrowserVisible(true, "the browser view returns after the dialog closes");

  // Take over and hand back.
  await page.getByRole("button", { name: "接管", exact: true }).click();
  await page.getByText("你正在操作 · AI 已暂停").first().waitFor();
  await page.getByRole("button", { name: "交回 AI" }).click();
  assert.deepEqual(actions.filter(item => ["takeover", "handback"].includes(item.action)).map(item => item.params), [{ target: "browser" }, { target: "browser" }]);

  // Local computer mode needs an explicit confirmation; cancelling changes nothing.
  await page.getByRole("radio", { name: "本机电脑" }).click();
  await page.getByText("切换到本机电脑模式？").waitFor();
  await page.getByText(/真实鼠标和键盘/).first().waitFor();
  await page.getByRole("button", { name: "取消" }).click();
  assert.ok(!actions.some(item => item.action === "mode"), "cancel must not switch modes");
  await page.getByRole("radio", { name: "本机电脑" }).click();
  await page.getByRole("button", { name: "授权并切换" }).click();
  assert.deepEqual(actions.find(item => item.action === "mode").params, { threadId: "fixture", mode: "host", confirmed: true });
  await page.getByText("已授权 AI 操作本机电脑").waitFor();
  assert.equal(viewport(), null, "local-computer mode hides the browser view");
  if (process.env.CLEO_SMOKE_OUTPUT) {
    await mkdir(process.env.CLEO_SMOKE_OUTPUT, { recursive: true });
    await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "computer-host-mode.png") });
  }
  await page.getByRole("button", { name: "撤销授权，切回内置浏览器" }).click();
  assert.deepEqual(actions.filter(item => item.action === "mode").at(-1).params, { threadId: "fixture", mode: "browser" });

  // An AI request for local control is shown as a request the user must answer.
  state = { ...state, authorization: { id: "req1", threadId: "fixture", reason: "需要打开记事本" } };
  await page.evaluate(next => window.pushComputerState(next), state);
  await page.getByText(/需要打开记事本/).waitFor();
  await page.getByRole("button", { name: "拒绝" }).click();
  assert.deepEqual(actions.find(item => item.action === "authorize").params, { id: "req1", granted: false });

  // Stop reports the confirmed result from the broker.
  state = { ...state, lastStop: { at: Date.now(), source: "panel", threadId: "fixture", released: [], cancelledRun: false, settled: false, hostError: null } };
  await page.evaluate(next => window.pushComputerState(next), state);
  await page.getByText(/正在停止电脑操作/).waitFor();
  assert.equal(await page.getByText(/^已停止/).count(), 0, "pending cleanup is never displayed as stopped");
  await page.getByRole("button", { name: "停止" }).click();
  await page.getByText(/已停止任务，释放了 1 个按键或按钮/).waitFor();

  // Files sidebar: tree, preview, markdown and a chat link reveal with the target line.
  await page.getByRole("button", { name: "README.md" }).click();
  await page.getByRole("heading", { name: "标题" }).waitFor();
  await page.getByRole("button", { name: "logo.png" }).click();
  assert.equal(await page.locator(".files-image img").getAttribute("src"), "cleo-file://root/logo.png");
  await page.getByRole("button", { name: "定位聊天链接" }).click();
  await page.locator(".files-code span.target").getByText("line three").waitFor();
  await page.getByRole("button", { name: "在内置浏览器中打开" }).click();
  assert.deepEqual(actions.find(item => item.action === "preview").params, { root: "C:\\work", path: "src/app.ts" });
  assert.equal(await page.locator("html").getAttribute("data-browser"), "open");
  assert.deepEqual(errors, []);
  console.log("computer panel smoke passed");
} finally {
  await browser?.close();
  await server.close();
}
