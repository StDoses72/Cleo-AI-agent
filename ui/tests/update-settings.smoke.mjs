import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { snapshot } from "../src/services/mockData.ts";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "cleo-update-settings-"));
const server = await createServer({ root: ui, cacheDir: join(scratch, "vite"), server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(fixture => {
    const listeners = new Set();
    const control = window.updateTest = { checks: [], downloads: 0, installs: 0, fail: false, hold: false, hidden: false, offset: 0, release: null };
    const now = Date.now;
    Date.now = () => now() + control.offset;
    Object.defineProperty(document, "hidden", { get: () => control.hidden, configurable: true });
    let update = { phase: "idle", currentVersion: "0.4.8", latestVersion: null, downloadedBytes: 0, totalBytes: 0, error: null };
    const set = patch => { update = { ...update, ...patch }; for (const listener of listeners) listener(update); };
    control.set = set;
    control.advance = () => { control.offset += 300001; window.dispatchEvent(new Event("focus")); };
    window.cleoDesktop = {
      request: async (method, params = {}) => {
        if (method === "load_workspace") return fixture;
        if (method === "load_memory") return { memories: fixture.memories, memoryOverview: fixture.memoryOverview };
        if (method === "load_thread") return fixture.threads.find(thread => thread.id === params.thread_id);
        if (method === "get_pending_questions") return [];
        if (method === "get_runtime_catalog") return { nonProductivityProfiles: [], defaultNonProductivityProfile: "", defaultProductivityProvider: "codex", productivityProviders: [] };
        if (method === "get_productivity_models") return { provider: "codex", source: "sdk", models: [] };
        if (method === "get_model_settings") return { profiles: [], connections: [], activeAgent: "", activeDreamAgent: "" };
        if (method === "get_agent_instructions") return { content: "", path: "AGENTS.md", exists: false };
        throw new Error(`Unhandled fixture method: ${method}`);
      },
      getEvolutionState: async () => ({ phase: "idle", supported: false, builds: [], releases: [] }),
      onEvolutionState: () => () => {}, confirmHealthy: async () => {}, onStreamEvent: () => () => {},
      getUpdateState: async () => update,
      onUpdateState: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      checkForUpdates: async tag => {
        control.checks.push(tag ?? null);
        set({ phase: "checking", operationBusy: true, error: null, ...(tag ? { selectedTag: tag } : {}) });
        if (control.hold) await new Promise(resolve => { control.release = resolve; });
        set({ phase: control.fail ? "error" : "available", error: control.fail ? "版本服务暂时不可用" : null,
          latestVersion: (update.selectedTag || "v0.5.0").slice(1), checkedAt: Date.now(), releases: [
            { tag: "v0.5.0", title: "New", prerelease: false, reason: null },
            { tag: "v0.4.0", title: "Old", prerelease: false, reason: null },
          ] });
        const response = update;
        set({ operationBusy: false });
        return response; // The final state event supersedes this busy response.
      },
      downloadUpdate: async () => { control.downloads++; return update; },
      installUpdate: async () => { control.installs++; return false; },
    };
  }, snapshot);
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByTestId("composer-input").waitFor();
  assert.equal(await page.evaluate(() => window.updateTest.checks.length), 0);
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  const open = async () => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settings.getByRole("button", { name: "更新", exact: true }).click();
  };
  await open();
  const download = settings.getByRole("button", { name: "下载更新", exact: true });
  await download.and(page.locator(":enabled")).waitFor();
  assert.equal(await page.evaluate(() => window.updateTest.checks.length), 1);
  assert.equal(await settings.getByRole("button", { name: /检查更新|重新检查|刷新版本/ }).count(), 0);
  await settings.getByText("其他版本", { exact: true }).click();
  await settings.getByLabel("目标更新版本").selectOption("v0.4.0");
  await settings.getByText("已选择 0.4.0", { exact: true }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  assert.equal(await page.evaluate(() => window.updateTest.checks.length), 2);
  await page.evaluate(() => { window.updateTest.hold = true; window.updateTest.advance(); });
  await page.waitForFunction(() => Boolean(window.updateTest.release));
  await page.evaluate(() => { for (let i = 0; i < 4; i++) window.dispatchEvent(new Event("focus")); });
  assert.equal(await page.evaluate(() => window.updateTest.checks.length), 3);
  await page.evaluate(() => { window.updateTest.hold = false; window.updateTest.release(); });
  await download.and(page.locator(":enabled")).waitFor();
  assert.equal(await settings.getByLabel("目标更新版本").inputValue(), "v0.4.0");
  await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.evaluate(() => window.updateTest.advance());
  assert.equal(await page.evaluate(() => window.updateTest.checks.length), 3, "Closed settings must not poll");
  await open();
  await page.waitForFunction(() => window.updateTest.checks.length === 4);
  await download.and(page.locator(":enabled")).waitFor();
  await page.evaluate(() => { window.updateTest.hidden = true; window.updateTest.advance(); });
  assert.equal(await page.evaluate(() => window.updateTest.checks.length), 4);
  await page.evaluate(() => { window.updateTest.hidden = false; window.updateTest.fail = true; document.dispatchEvent(new Event("visibilitychange")); });
  await settings.getByRole("alert").getByText("版本服务暂时不可用", { exact: true }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  assert.equal(await page.evaluate(() => window.updateTest.checks.length), 5, "A failed check must back off");
  await page.evaluate(() => { window.updateTest.fail = false; });
  await settings.getByRole("button", { name: "重试", exact: true }).click();
  await download.and(page.locator(":enabled")).waitFor();
  await page.evaluate(() => window.updateTest.set({ phase: "ready" }));
  await settings.getByRole("button", { name: "重启并安装", exact: true }).waitFor();
  await page.evaluate(() => window.updateTest.advance());
  assert.equal(await page.evaluate(() => window.updateTest.checks.length), 6, "A verified download should remain ready");
  await page.evaluate(() => window.updateTest.set({ phase: "updated", checkedAt: undefined, releases: undefined }));
  await page.waitForFunction(() => window.updateTest.checks.length === 7);
  await download.and(page.locator(":enabled")).waitFor();
  assert.deepEqual(await page.evaluate(() => [window.updateTest.downloads, window.updateTest.installs]), [0, 0]);
  assert.deepEqual(errors, []);
  console.log("PASS: automatic update freshness, deduplication, hidden/closed-page pause, selected version, failure backoff/retry and explicit installation");
} finally {
  await browser?.close(); await server.close();
  assert.equal(dirname(scratch), resolve(tmpdir()));
  await rm(scratch, { recursive: true, force: true });
}
