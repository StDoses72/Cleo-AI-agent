import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { snapshot } from "../src/services/mockData.ts";
import { resizeWindow } from "./window-size.mjs";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(process.env.CLEO_TEST_TMP || tmpdir(), "cleo-program-updates-smoke-"));
const appDir = join(scratch, "app");
let application;
let page;

async function captureScreenshot(name) {
  if (!process.env.CLEO_SMOKE_OUTPUT) return;
  await mkdir(process.env.CLEO_SMOKE_OUTPUT, { recursive: true });
  const dataUrl = await application.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
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
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await application.context().addInitScript(({ snapshot }) => {
    const base = snapshot.threads.find(thread => thread.space === "productivity");
    const runtime = { ...snapshot.runtime, provider: "codex", model: "gpt-6-astra", effort: "low" };
    const thread = { ...base, id: "program-updates", title: "更新与进化互斥检查", runtime,
      items: [{ id: "update-message", type: "message", role: "assistant", time: "12:00", content: "后台下载时可以继续编辑消息。" }],
      history: { before: "0", after: "0", hasBefore: false, hasAfter: false, total: 1, revision: "1" },
    };
    let update = { phase: "ready", currentVersion: "0.3.11", latestVersion: "0.4.0", error: null,
      downloadedBytes: 700 * 1024 * 1024, totalBytes: 700 * 1024 * 1024,
      operationBusy: false, blocksTasks: false, installStage: null };
    let evolution = { phase: "idle", supported: true, prepared: true, currentVersion: "0.3.11",
      active: "official-0.3.11", baseline: "official-0.3.11", baseTag: "v0.3.11", source: null, threadId: null,
      error: null, logs: "", builds: [], releases: [], pullRequest: null, recoveryPath: null,
      iteration: null, draftDirty: false };
    const updateListeners = new Set();
    const evolutionListeners = new Set();
    const calls = { check: 0, download: 0, install: 0, turn: 0 };
    let finishInstall;
    const setUpdate = patch => {
      update = { ...update, ...patch };
      for (const listener of updateListeners) listener(update);
    };
    const setEvolution = patch => {
      evolution = { ...evolution, ...patch };
      for (const listener of evolutionListeners) listener(evolution);
    };
    window.__programUpdatesTest = {
      setUpdate, setEvolution, calls,
      completeInstall(error = null) {
        setUpdate({ phase: error ? "ready" : "updated", error, operationBusy: false, blocksTasks: false, installStage: null });
        finishInstall?.(false);
        finishInstall = null;
      },
    };
    window.cleoDesktop = {
      async request(method) {
        if (method === "load_workspace") return { ...snapshot, runtime, threads: [thread], activeThreadId: thread.id, activeSpace: "productivity" };
        if (method === "load_memory") return structuredClone({ memories: snapshot.memories, memoryOverview: snapshot.memoryOverview });
        if (method === "load_thread") return thread;
        if (method === "load_timeline") return { ...thread.history, items: thread.items };
        if (method === "get_pending_questions") return [];
        if (method === "get_model_settings") return { profiles: [], activeAgent: "", activeDreamAgent: "" };
        if (method === "get_agent_instructions") return { content: "", exists: false, path: "AGENTS.md" };
        if (method === "get_runtime_catalog") return { nonProductivityProfiles: [], defaultNonProductivityProfile: "", defaultProductivityProvider: "codex",
          productivityProviders: [{ id: "codex", type: "codex_sdk", defaultModel: runtime.model, modelSource: "config" }] };
        if (method === "get_productivity_models") return { provider: "codex", source: "sdk", models: [{ id: runtime.model,
          label: runtime.model, isDefault: true, defaultEffort: "low", supportedEfforts: ["low"] }] };
        if (method === "stream_turn") { calls.turn += 1; throw new Error("Version-switch guard allowed a turn"); }
        throw new Error(`Unhandled program-update fixture method: ${method}`);
      },
      onStreamEvent: () => () => {},
      getEvolutionState: async () => evolution,
      onEvolutionState: listener => { evolutionListeners.add(listener); return () => evolutionListeners.delete(listener); },
      getUpdateState: async () => update,
      onUpdateState: listener => { updateListeners.add(listener); return () => updateListeners.delete(listener); },
      checkForUpdates: async () => { calls.check += 1; return update; },
      downloadUpdate: async () => { calls.download += 1; return update; },
      installUpdate() {
        calls.install += 1;
        setUpdate({ phase: "installing", operationBusy: true, blocksTasks: true, installStage: "preparing", error: null });
        return new Promise(resolve => { finishInstall = resolve; });
      },
      confirmHealthy: async () => {},
    };
  }, { snapshot });
  await page.reload();
  await page.getByTestId("composer-input").waitFor();
  const notice = page.locator(".update-notice");
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  const input = page.getByTestId("composer-input");
  const send = page.getByTestId("send-button");
  const updateAction = page.locator(".update-actions button");
  const setUpdate = patch => page.evaluate(patch => window.__programUpdatesTest.setUpdate(patch), patch);
  const setEvolution = patch => page.evaluate(patch => window.__programUpdatesTest.setEvolution(patch), patch);
  const counts = () => page.evaluate(() => ({ ...window.__programUpdatesTest.calls }));
  const closeSettings = async () => {
    if (await settings.isVisible()) await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
    await settings.waitFor({ state: "hidden" });
  };
  async function openUpdates() {
    if (!await settings.isVisible()) await page.getByRole("button", { name: "设置", exact: true }).click();
    await settings.getByRole("button", { name: "更新", exact: true }).click();
    await page.locator(".update-settings-page").waitFor();
  }
  async function assertDisabled(button, disabled, message) {
    // IPC events schedule a React render; wait for the resulting control state.
    await button.and(page.locator(disabled ? ":disabled" : ":enabled")).waitFor();
    assert.equal(await button.isDisabled(), disabled, message);
  }
  async function assertInstallDisabled(message) {
    await assertDisabled(notice.getByRole("button", { name: "重启安装", exact: true }), true, message);
    await assertDisabled(updateAction, true, message);
    await notice.getByText("请先保存或放弃本轮进化，再安装更新。", { exact: true }).waitFor();
    assert.match(await notice.innerText(), /先保存或放弃本轮进化/);
  }
  async function assertNoEnabledInstall() {
    const buttons = page.getByRole("button", { name: /重启.*安装/ });
    for (const button of await buttons.all()) assert(await button.isDisabled(), "A second install entry remains enabled");
  }
  async function checkGeometry(label) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const state = await page.evaluate(() => {
      const visible = [...document.querySelectorAll(".update-notice, .settings-modal, .update-actions button, .update-notice button, .update-hero p")]
        .filter(element => element.getBoundingClientRect().width > 0);
      return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
        boxes: visible.map(element => ({ name: element.className || element.tagName, ...element.getBoundingClientRect().toJSON(),
          scrollWidth: element.scrollWidth, clientWidth: element.clientWidth })) };
    });
    assert(state.documentWidth <= state.width + 1 && state.documentHeight <= state.height + 1, `Document overflow (${label}): ${JSON.stringify(state)}`);
    for (const box of state.boxes) {
      assert(box.x >= -1 && box.right <= state.width + 1 && box.y >= -1 && box.bottom <= state.height + 1,
        `Update control outside viewport (${label}): ${JSON.stringify(box)}`);
      assert(box.scrollWidth <= box.clientWidth + 1, `Update copy/control overflows (${label}): ${JSON.stringify(box)}`);
    }
  }

  await notice.getByRole("button", { name: "重启安装", exact: true }).waitFor();
  await openUpdates();
  assert.doesNotMatch(await settings.innerText(), /下次启动自动安装/);
  assert.match(await settings.innerText(), /点击后重启安装/);
  await assertDisabled(updateAction, false);
  await setEvolution({ iteration: { base: "official-0.3.11", startedAt: "2026-09-13T12:00:00Z" } });
  await assertInstallDisabled("Unsaved iteration must block both install entries");
  await setEvolution({ iteration: null, draftDirty: true });
  await assertInstallDisabled("Dirty draft must block both install entries");
  await setEvolution({ draftDirty: false, latestSaved: "local-saved" });
  await assertDisabled(updateAction, false, "Saving the iteration should restore installation");
  await assertDisabled(notice.getByRole("button", { name: "重启安装", exact: true }), false);
  console.log("PASS: ready copy, iteration/draft guards, saved-iteration recovery");

  await closeSettings();
  await input.fill("下载期间保留的草稿");
  await setUpdate({ phase: "downloading", downloadedBytes: 120 * 1024 * 1024, operationBusy: true, blocksTasks: false });
  await notice.getByText(/^正在下载更新/).waitFor();
  await input.fill("下载期间仍可编辑这条消息");
  await assertDisabled(send, false, "Ordinary download blocks sending");
  await openUpdates();
  await assertDisabled(updateAction, true, "A second update action is possible during download");
  await setUpdate({ phase: "available", operationBusy: true });
  await settings.getByRole("button", { name: "下载更新", exact: true }).waitFor();
  await assertDisabled(updateAction, true, "Settings download action ignores operationBusy");
  await assertDisabled(notice.getByRole("button", { name: "下载", exact: true }), true, "Notice download action ignores operationBusy");
  await setUpdate({ phase: "up-to-date", operationBusy: true });
  assert.equal(await updateAction.count(), 0, "A current version does not need a manual check button");
  assert.deepEqual(await counts(), { check: 0, download: 0, install: 0, turn: 0 });
  console.log("PASS: one update operation at a time; ordinary downloads preserve the composer");

  await setUpdate({ phase: "ready", operationBusy: false });
  await closeSettings();
  await notice.getByRole("button", { name: "重启安装", exact: true }).click();
  await notice.getByText("正在校验并解压更新…", { exact: true }).waitFor();
  await assertNoEnabledInstall();
  await assertDisabled(send, true, "Install preparation permits a new turn");
  await input.press("Enter");
  assert.equal((await counts()).turn, 0, "Enter bypasses the version-switch guard");
  await openUpdates();
  await assertDisabled(updateAction, true, "Settings allows another update during preparation");
  await page.evaluate(() => window.__programUpdatesTest.completeInstall("校验失败，请重试。"));
  await notice.getByText("校验失败，请重试。", { exact: true }).waitFor();
  assert.match(await settings.innerText(), /校验失败，请重试/);
  await assertDisabled(updateAction, false, "Failed preparation cannot be retried");
  await updateAction.click();
  await notice.getByText("正在校验并解压更新…", { exact: true }).waitFor();
  await assertNoEnabledInstall();
  assert.equal((await counts()).install, 2, "Install retry did not use the same action");
  await setUpdate({ installStage: "restarting" });
  await notice.getByText("正在启动新版本…", { exact: true }).waitFor();
  assert.match(await settings.innerText(), /正在启动新版本/);
  await assertDisabled(updateAction, true);
  await closeSettings();
  await assertDisabled(send, true, "Restarting permits a new turn");
  assert.equal(await input.inputValue(), "下载期间仍可编辑这条消息", "Version operation discarded the draft");
  await page.evaluate(() => window.__programUpdatesTest.completeInstall("启动失败，请重试。"));
  await notice.getByText("启动失败，请重试。", { exact: true }).waitFor();
  await assertDisabled(notice.getByRole("button", { name: "重启安装", exact: true }), false, "Failed installation cannot be retried");
  await assertDisabled(send, false, "Failed installation leaves tasks blocked");
  console.log("PASS: immediate installing state, blocked sends, preparing/restarting copy, failure and retry");

  for (const scenario of [
    { name: "wide", width: 1500, height: 960, zoom: 1 },
    { name: "compact", width: 1080, height: 760, zoom: 1 },
    { name: "compact-zoom", width: 1080, height: 760, zoom: 1.25 },
  ]) {
    await resizeWindow(application, page, scenario);
    for (const theme of ["dark", "light"]) {
      const label = `${scenario.name}-${theme}`;
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await setUpdate({ phase: "ready", error: null, operationBusy: false, blocksTasks: false });
      await setEvolution({ iteration: { base: "official-0.3.11", startedAt: "2026-09-13T12:00:00Z" } });
      await openUpdates();
      await assertInstallDisabled(label);
      await checkGeometry(`${label}-blocked`);
      await captureScreenshot(`program-updates-${label}-blocked.png`);
      await setEvolution({ iteration: null });
      await setUpdate({ phase: "installing", operationBusy: true, blocksTasks: true, installStage: "preparing" });
      await notice.getByText("正在校验并解压更新…", { exact: true }).waitFor();
      await checkGeometry(`${label}-preparing`);
      await closeSettings();
      await checkGeometry(`${label}-notice`);
      await captureScreenshot(`program-updates-${label}-installing.png`);
    }
  }
  assert.deepEqual(errors, [], "Renderer errors during update checks");
  assert.deepEqual(await counts(), { check: 0, download: 0, install: 2, turn: 0 });
  console.log(JSON.stringify({ status: "passed", scenarios: 6,
    checks: ["draft-protection", "shared-busy-state", "download-keeps-chat", "install-blocks-tasks", "retry", "themes", "overflow"] }));
} catch (error) {
  if (page && !page.isClosed()) {
    console.error(await page.evaluate(() => ({ notice: document.querySelector(".update-notice")?.innerText,
      settings: document.querySelector(".update-settings-page")?.innerText, width: innerWidth, height: innerHeight })));
    await captureScreenshot("program-updates-failure.png");
  }
  throw error;
} finally {
  try { if (application) await application.close(); }
  finally { await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
