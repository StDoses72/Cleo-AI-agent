import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { snapshot } from "../src/services/mockData.ts";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({ root: ui, server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 950 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let runtime = "isolated", reject = false, canSwitch = true;
  const selections = [];
  await page.exposeFunction("testDesktop", async (action = "status", value = "") => {
    if (action === "select") {
      selections.push(value);
      if (reject) throw new Error("任务正在运行，不能切换");
      runtime = value;
    }
    return { runtime, phase: runtime === "host" ? "external" : "stopped", hostSupported: true, canSwitch };
  });
  await page.addInitScript(() => {
    window.cleoDesktop = { computerDesktop: (...args) => window.testDesktop(...args) };
  });
  const fixtureUrl = `${server.resolvedUrls.local[0]}tests/fixtures/computer-preview.html`;
  await page.goto(fixtureUrl);
  const selector = page.getByLabel("电脑操作环境");
  await selector.waitFor();
  assert(await selector.isDisabled(), "A running task must lock the destination");
  await page.getByRole("button", { name: "切换运行状态" }).click();
  await selector.and(page.locator(":enabled")).waitFor();
  await selector.selectOption("host");
  await page.getByText("直接操作你的电脑", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("remote-desktop").count(), 0);
  assert.equal(await page.getByRole("button", { name: "打开独立桌面" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "暂停观看" }).count(), 0);
  if (process.env.CLEO_SMOKE_OUTPUT) {
    await mkdir(process.env.CLEO_SMOKE_OUTPUT, { recursive: true });
    await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "host-desktop-mode.png") });
  }
  await page.reload();
  await page.getByText("直接操作你的电脑", { exact: true }).waitFor();
  assert.equal(await selector.inputValue(), "host", "Reload must reflect the saved target");
  await page.getByRole("button", { name: "停止任务", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("data-stopped"), "true");
  await page.getByRole("button", { name: "切换运行状态" }).click();
  reject = true;
  await selector.selectOption("isolated");
  await page.getByRole("status").getByText("任务正在运行，不能切换", { exact: false }).waitFor();
  assert.equal(await selector.inputValue(), "host", "Rejected switches must not change the destination");
  reject = false;
  await selector.selectOption("isolated");
  await page.getByRole("button", { name: "打开独立桌面", exact: true }).waitFor();
  assert.equal(await selector.inputValue(), "isolated");
  canSwitch = false;
  await selector.and(page.locator(":disabled")).waitFor();
  assert.deepEqual(selections, ["host", "isolated", "isolated"]);
  assert.deepEqual(errors, []);
  await page.close();

  // Exercise the actual App effect: only guest tool calls may open the embedded viewer.
  for (const target of ["host", "isolated", "composer"]) {
    const context = await browser.newContext();
    const app = await context.newPage();
    app.setDefaultTimeout(8000);
    await app.addInitScript(({ fixture, target }) => {
      const thread = fixture.threads[0];
      thread.status = target === "composer" ? "completed" : "running";
      thread.canUndo = target === "isolated";
      thread.activeRunId = "computer-mode-test";
      thread.items = target === "composer" ? [] : [{ id: "snapshot", type: "tool", name: "computer_tools", status: "running", command: "{}" }];
      fixture.activeThreadId = thread.id;
      window.desktopStatusRead = false;
      window.cleoDesktop = {
        computerDesktop: async () => {
          window.desktopStatusRead = true;
          return { runtime: target, phase: target === "host" ? "external" : "stopped", canSwitch: false };
        },
        request: async (method, params = {}) => {
          if (method === "load_workspace") return fixture;
          if (method === "load_thread") return fixture.threads.find(row => row.id === params.thread_id);
          if (method === "load_memory") return { memories: fixture.memories, memoryOverview: fixture.memoryOverview };
          if (method === "get_runtime_catalog") return { nonProductivityProfiles: [], defaultNonProductivityProfile: "", defaultProductivityProvider: "codex", productivityProviders: [] };
          if (method === "get_productivity_models") return { provider: "codex", source: "sdk", models: [] };
          if (method === "get_pending_questions" || method === "get_local_skills") return [];
          throw new Error(`Unexpected request: ${method}`);
        },
        onStreamEvent: () => () => {},
        getEvolutionState: async () => ({ phase: "idle", supported: false, builds: [], releases: [] }),
        onEvolutionState: () => () => {}, confirmHealthy: async () => {},
        getUpdateState: async () => ({ phase: "unsupported", currentVersion: "test" }), onUpdateState: () => () => {},
      };
    }, { fixture: structuredClone(snapshot), target });
    await app.goto(server.resolvedUrls.local[0]);
    if (target === "composer") {
      const input = app.getByTestId("composer-input");
      await input.fill("/computeruse 打开浏览器");
      await app.getByLabel("移除 Computer Use").waitFor();
      assert.equal(await input.inputValue(), "打开浏览器");
      assert.equal(await app.getByRole("button", { name: "回退 Git 改动" }).count(), 0);
      await input.fill("搜索课程");
      await app.getByLabel("移除 Computer Use").click();
      assert.equal(await input.inputValue(), "搜索课程");
      await input.fill("/computeruse ");
      await input.press("Backspace");
      assert.equal(await input.inputValue(), "");
      assert.equal(await app.getByLabel("移除 Computer Use").count(), 0);
      await input.fill("/computeruse 打开浏览器搜索课程");
      if (process.env.CLEO_SMOKE_OUTPUT) await app.screenshot({path: join(process.env.CLEO_SMOKE_OUTPUT, "computer-use-composer.png")});
      await context.close();
      continue;
    }
    await app.waitForFunction(() => window.desktopStatusRead);
    if (target === "isolated") await app.getByLabel("电脑操作环境").waitFor();
    else {
      await app.getByTestId("stop-button").waitFor();
      assert.equal(await app.locator(".computer-preview").count(), 0, "Host operations must not force open the panel");
    }
    await context.close();
  }
  console.log("COMPUTER_MODES_UI_PASSED: selection, persistence, busy rejection, stop, host without viewer, guest auto-preview");
} finally {
  await browser?.close();
  await server.close();
}
