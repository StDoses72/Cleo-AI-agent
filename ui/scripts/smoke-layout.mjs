import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshot } from "../src/services/mockData.ts";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "cleo-layout-smoke-"));
const appDir = join(scratch, "app");
let application;
let page;

async function captureScreenshot(name) {
  if (!process.env.CLEO_SMOKE_OUTPUT) return;
  await mkdir(process.env.CLEO_SMOKE_OUTPUT, { recursive: true });
  const dataUrl = await application.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].capturePage();
    return image.toDataURL();
  });
  assert(dataUrl.startsWith("data:image/png;base64,"), "Native capture did not return a PNG");
  await writeFile(join(process.env.CLEO_SMOKE_OUTPUT, name), Buffer.from(dataUrl.split(",", 2)[1], "base64"));
}

try {
  await mkdir(appDir);
  await cp(join(ui, "electron"), join(appDir, "electron"), { recursive: true });
  await cp(join(ui, "package.json"), join(appDir, "package.json"));
  const build = spawnSync(process.execPath, [join(ui, "node_modules/vite/bin/vite.js"), "build", "--outDir", join(appDir, "dist")], {
    cwd: ui, stdio: "pipe", windowsHide: true,
  });
  assert.equal(build.status, 0, build.stderr?.toString());
  application = await electron.launch({
    args: [appDir, `--user-data-dir=${join(scratch, "profile")}`],
    env: { ...process.env, CLEO_DESKTOP_MOCK: "1", CLEO_HOME: join(scratch, "home") },
  });
  page = await application.firstWindow();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await application.context().addInitScript(({ snapshot }) => {
    const rows = Array.from({ length: 160 }, (_, i) => ({
      id: `layout-${i}`, order: i, cursor: String(i), turnId: `layout-${i - i % 2}`, turnHasAnswer: true,
      type: "message", role: i % 2 ? "assistant" : "user", time: "12:00",
      content: `布局记录 ${i}\n\n${i === 159 ? "最后一条消息应完整显示在输入框上方。" : "聊天内容保持自然流动，检查边栏、标题与输入框之间的空间。"}`,
    }));
    const base = snapshot.threads.find(thread => thread.space === "productivity");
    const runtime = { ...snapshot.runtime, provider: "codex", model: "gpt-6-astra", effort: "low" };
    const pageOf = (direction = "latest", cursor) => {
      const pivot = Number(cursor);
      const start = direction === "latest" ? Math.max(0, rows.length - 80)
        : direction === "before" ? Math.max(0, pivot - 80) : pivot + 1;
      const end = direction === "before" ? pivot : Math.min(rows.length, start + 80);
      return { items: rows.slice(start, end), before: String(start), after: String(end - 1),
        hasBefore: start > 0, hasAfter: end < rows.length, total: rows.length, revision: String(rows.length) };
    };
    const load = () => {
      const { items, ...history } = pageOf();
      return { ...base, id: "layout", title: "检查聊天、输入框与侧栏布局", runtime, items, history };
    };
    window.cleoDesktop = {
      async request(method, params = {}) {
        if (method === "load_workspace") return { ...snapshot, runtime, threads: [load()], activeThreadId: "layout", activeSpace: "productivity" };
        if (method === "load_thread") return load();
        if (method === "load_timeline") return pageOf(params.direction, params.cursor);
        if (method === "get_pending_questions") return [];
        if (method === "get_runtime_catalog") return { nonProductivityProfiles: [], defaultNonProductivityProfile: "", defaultProductivityProvider: "codex",
          productivityProviders: [{ id: "codex", type: "codex_sdk", defaultModel: runtime.model, modelSource: "config" }] };
        if (method === "get_productivity_models") return { provider: "codex", source: "sdk", models: Array.from({ length: 30 }, (_, index) => ({
          id: index === 29 ? runtime.model : `test-${index}`, label: index === 29 ? runtime.model : `模型 ${index}`,
          description: "用于验证模型列表滚动与菜单边界", isDefault: index === 29, defaultEffort: "low", supportedEfforts: ["low"],
        })) };
        throw new Error(`Unhandled layout fixture method: ${method}`);
      },
      onStreamEvent: () => () => {},
      getEvolutionState: async () => ({ phase: "idle", builds: [], releases: [], supported: false }),
      onEvolutionState: () => () => {},
      getUpdateState: async () => ({ phase: "unsupported", currentVersion: "test" }),
      onUpdateState: () => () => {}, confirmHealthy: async () => {}, setTheme: () => {},
    };
  }, { snapshot });
  await page.reload();
  await page.getByText("最后一条消息应完整显示在输入框上方。", { exact: true }).waitFor();
  await page.locator(".evolution-cases").waitFor();

  const viewport = page.locator(".conversation-viewport");
  const inspector = page.getByTestId("inspector");
  const latest = page.getByRole("button", { name: "回到最新", exact: true });
  async function settle() {
    await page.waitForFunction(() => !document.querySelector(".app-shell").getAnimations()
      .some(animation => animation.playState === "running"));
    // ResizeObserver-driven composer and virtual-row measurements need two paint cycles.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  async function jumpLatest() {
    if (await latest.count()) await latest.click();
    await page.waitForFunction(() => {
      const view = document.querySelector(".conversation-viewport");
      return view.scrollHeight - view.clientHeight - view.scrollTop < 3;
    });
    await settle();
  }
  async function openInspector() {
    if (!await inspector.count()) await page.getByRole("button", { name: "打开检查器", exact: true }).click();
    await inspector.waitFor();
    await settle();
  }
  async function checkGeometry(label) {
    const state = await page.evaluate(() => {
      const rect = selector => {
        const element = document.querySelector(selector);
        const box = element.getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
      };
      const tabs = document.querySelector(".inspector-tabs");
      const styles = selector => {
        const css = getComputedStyle(document.querySelector(selector));
        return { background: css.backgroundColor, image: css.backgroundImage, pointerEvents: css.pointerEvents };
      };
      return {
        width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight,
        shell: rect(".conversation-shell"), inspector: rect(".inspector"), header: rect(".conversation-header"), cases: rect(".evolution-cases"),
        viewport: rect(".conversation-viewport"), composer: rect(".composer"), input: rect('[data-testid="composer-input"]'),
        send: rect('[data-testid="send-button"]'), tabs: rect(".inspector-tabs"),
        tabScrollHeight: tabs.scrollHeight, tabClientHeight: tabs.clientHeight, tabOverflow: getComputedStyle(tabs).overflowY,
        tabButtons: [...tabs.querySelectorAll("button")].map(element => {
          const box = element.getBoundingClientRect();
          return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
        }),
        bottomStyle: styles(".conversation-bottom"), dockStyle: styles(".composer-dock"), composerStyle: styles(".composer"),
      };
    });
    const context = `${label}: ${JSON.stringify(state)}`;
    assert(state.documentWidth <= state.width + 1 && state.documentHeight <= state.height + 1, `Window overflow: ${context}`);
    assert(state.shell.right <= state.inspector.left + 1, `Inspector covers the conversation: ${context}`);
    assert(state.inspector.right <= state.width + 1, `Inspector extends outside the window: ${context}`);
    assert(state.composer.left >= state.shell.left && state.composer.right <= state.shell.right + 1, `Composer is clipped by a panel: ${context}`);
    assert(state.composer.top >= state.viewport.top && state.composer.bottom <= state.height + 1, `Composer is clipped vertically: ${context}`);
    for (const control of [state.input, state.send]) {
      assert(control.left >= state.composer.left && control.right <= state.composer.right + 1
        && control.top >= state.composer.top && control.bottom <= state.composer.bottom + 1, `Composer control is clipped: ${context}`);
    }
    assert(state.header.bottom <= state.cases.top + 1 && state.cases.bottom <= state.viewport.top + 1, `Conversation header overlaps history: ${context}`);
    assert(state.tabScrollHeight <= state.tabClientHeight + 1 && state.tabOverflow !== "scroll", `Inspector tabs have vertical overflow: ${context}`);
    assert(state.tabButtons.every(box => box.left >= state.tabs.left - 1 && box.right <= state.tabs.right + 1
      && box.top >= state.tabs.top - 1 && box.bottom <= state.tabs.bottom + 1), `Inspector tabs are clipped: ${context}`);
    for (const style of [state.bottomStyle, state.dockStyle]) {
      assert(["transparent", "rgba(0, 0, 0, 0)"].includes(style.background) && style.image === "none", `Composer backdrop is opaque: ${context}`);
      assert.equal(style.pointerEvents, "none", `Composer whitespace captures pointer events: ${context}`);
    }
    assert.equal(state.composerStyle.pointerEvents, "auto", `Composer is not interactive: ${context}`);
    assert.equal(await page.locator(".history-help").count(), 0, "History implementation instructions remain visible");
    return state;
  }
  async function checkLastMessage(label) {
    await jumpLatest();
    const state = await page.evaluate(() => {
      const row = document.querySelector('[data-row-id="layout-159"]');
      const box = row?.getBoundingClientRect();
      const composer = document.querySelector(".composer").getBoundingClientRect();
      const view = document.querySelector(".conversation-viewport").getBoundingClientRect();
      return { row: box ? { top: box.top, bottom: box.bottom } : null, composerTop: composer.top, viewportTop: view.top };
    });
    assert(state.row && state.row.top >= state.viewportTop - 1 && state.row.bottom <= state.composerTop + 1,
      `Last message is covered by the composer (${label}): ${JSON.stringify(state)}`);
  }
  async function checkScrollAndHitTargets(label) {
    await viewport.hover();
    await page.mouse.wheel(0, -450);
    await latest.waitFor();
    assert.equal((await latest.innerText()).trim(), "", `Latest button still has visible copy (${label})`);
    assert.equal(await latest.locator("svg").count(), 1, `Latest button has no arrow (${label})`);
    const hits = await page.evaluate(() => {
      const bottom = document.querySelector(".conversation-bottom").getBoundingClientRect();
      const composer = document.querySelector(".composer").getBoundingClientRect();
      const input = document.querySelector('[data-testid="composer-input"]');
      const inputRect = input.getBoundingClientRect();
      const points = [
        { x: (bottom.left + composer.left) / 2, y: composer.top + composer.height / 2 },
        { x: (composer.right + bottom.right) / 2, y: composer.top + composer.height / 2 },
      ].filter(point => point.x < composer.left - 1 || point.x > composer.right + 1);
      return {
        whitespace: points.map(({ x, y }) => ({ x, y, reachesHistory: Boolean(document.elementFromPoint(x, y)?.closest(".conversation-viewport")) })),
        input: document.elementFromPoint(inputRect.left + inputRect.width / 2, inputRect.top + inputRect.height / 2) === input,
      };
    });
    assert(hits.whitespace.length > 0 && hits.whitespace.every(point => point.reachesHistory),
      `Composer whitespace blocks the underlying history (${label}): ${JSON.stringify(hits)}`);
    assert(hits.input, `Input cannot be focused through the composer overlay (${label})`);
    await latest.click();
    await checkLastMessage(label);
  }
  async function checkRuntimeMenu(label) {
    const trigger = page.getByTestId("runtime-selector");
    const menu = page.getByTestId("runtime-menu");
    const checkBounds = async stage => {
      await menu.waitFor();
      await menu.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
      const state = await page.evaluate(() => {
        const shell = document.querySelector(".conversation-shell").getBoundingClientRect();
        const menu = document.querySelector(".runtime-menu").getBoundingClientRect();
        const list = document.querySelector(".runtime-menu-list");
        return { shell: shell.toJSON(), menu: menu.toJSON(), scrollHeight: list.scrollHeight, clientHeight: list.clientHeight };
      });
      assert(state.menu.left >= state.shell.left - 2 && state.menu.right <= state.shell.right + 2
        && state.menu.top >= state.shell.top - 2 && state.menu.bottom <= state.shell.bottom + 2,
      `Runtime ${stage} menu extends outside the conversation (${label}): ${JSON.stringify(state)}`);
      return state;
    };
    await trigger.click();
    await checkBounds("harness");
    await menu.locator(".runtime-menu-row").filter({ hasText: "codex" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".runtime-menu-row").length === 30);
    const state = await checkBounds("model");
    assert(state.scrollHeight > state.clientHeight + 100, `Long model list does not scroll (${label})`);
    const list = menu.locator(".runtime-menu-list");
    await list.hover();
    await page.mouse.wheel(0, 10000);
    await page.waitForFunction(() => {
      const list = document.querySelector(".runtime-menu-list");
      return list.scrollHeight - list.scrollTop - list.clientHeight < 3;
    });
    await captureScreenshot(`layout-model-menu-${label}.png`);
    // Select the current model to prove that a scrolled row receives a real click,
    // without leaving the historical conversation for a new draft task.
    await menu.getByRole("button", { name: /gpt-6-astra/ }).click();
    await menu.waitFor({ state: "detached" });
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    await trigger.click();
    await checkBounds("reopened harness");
    await trigger.click();
    await menu.waitFor({ state: "detached" });
  }

  const scenarios = [
    { name: "wide", width: 1600, height: 1000, zoom: 1 },
    { name: "compact", width: 1080, height: 760, zoom: 1 },
    { name: "zoom", width: 1600, height: 1000, zoom: 1.5 },
    { name: "compact-zoom", width: 1080, height: 760, zoom: 1.5 },
  ];
  for (const scenario of scenarios) {
    const size = await application.evaluate(({ BrowserWindow }, { width, height, zoom }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window.isMaximized()) window.unmaximize();
      window.setContentSize(width, height);
      window.webContents.setZoomFactor(zoom);
      return { bounds: window.getContentBounds(), zoom: window.webContents.getZoomFactor() };
    }, scenario);
    console.log(JSON.stringify({ scenario: scenario.name, ...size }));
    assert(size.bounds.width >= scenario.width - 4 && size.bounds.height >= scenario.height - 60,
      `Runner reduced the requested test window too far: ${JSON.stringify(size)}`);
    await page.waitForFunction(({ bounds, zoom }) => Math.abs(innerWidth - bounds.width / zoom) <= 4
      && Math.abs(innerHeight - bounds.height / zoom) <= 4, size);
    if (scenario.name === "compact-zoom") {
      await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
    }
    for (const theme of ["dark", "light"]) {
      const label = `${scenario.name}-${theme}`;
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await openInspector();
      await jumpLatest();
      const open = await checkGeometry(label);
      await checkLastMessage(label);
      await checkScrollAndHitTargets(label);
      await checkRuntimeMenu(label);
      for (const tab of ["上下文", "运行", /^变更/]) {
        await inspector.locator(".inspector-tabs").getByRole("button", { name: tab }).click();
        await checkGeometry(label);
      }
      await captureScreenshot(`layout-${label}.png`);
      await inspector.getByRole("button", { name: "关闭检查器", exact: true }).click();
      await inspector.waitFor({ state: "detached" });
      await settle();
      const closedWidth = await page.locator(".conversation-shell").evaluate(element => element.getBoundingClientRect().width);
      assert(closedWidth > open.shell.width + 100, `Closing the inspector does not restore chat space (${label}): ${open.shell.width} → ${closedWidth}`);
      await checkLastMessage(`${label}-closed`);
    }
  }
  assert.deepEqual(errors, [], "Renderer errors during layout checks");
  console.log(JSON.stringify({ status: "passed", scenarios: scenarios.length * 2, checks: ["panels", "header", "composer", "scroll", "hit-targets", "tabs", "runtime-menu"] }));
} catch (error) {
  if (page && !page.isClosed()) {
    console.error(await page.evaluate(() => {
      const view = document.querySelector(".conversation-viewport");
      return { width: innerWidth, height: innerHeight, scrollTop: view?.scrollTop, scrollHeight: view?.scrollHeight,
        clientHeight: view?.clientHeight, lastRow: document.querySelector('[data-row-id="layout-159"]')?.getBoundingClientRect().toJSON(),
        composer: document.querySelector(".composer")?.getBoundingClientRect().toJSON(),
        latest: document.querySelector(".history-latest")?.outerHTML };
    }));
    await captureScreenshot("layout-failure.png");
  }
  throw error;
} finally {
  if (application) await application.close();
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
