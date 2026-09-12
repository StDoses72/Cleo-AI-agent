import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshot } from "../src/services/mockData.ts";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "cleo-history-smoke-"));
const appDir = join(scratch, "app");
let application;
try {
  await mkdir(appDir);
  await cp(join(ui, "electron"), join(appDir, "electron"), { recursive: true });
  await cp(join(ui, "package.json"), join(appDir, "package.json"));
  const build = spawnSync(process.execPath, [join(ui, "node_modules/vite/bin/vite.js"), "build", "--outDir", join(appDir, "dist")], { cwd: ui, stdio: "pipe", windowsHide: true });
  assert.equal(build.status, 0, build.stderr?.toString());
  if (!process.argv.includes("--regression-only")) {
  application = await electron.launch({ args: [appDir, `--user-data-dir=${join(scratch, "profile")}`],
    env: { ...process.env, CLEO_DESKTOP_MOCK: "1", CLEO_HOME: join(scratch, "home") } });
  const page = await application.firstWindow();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await application.context().addInitScript(({ snapshot }) => {
    const rows = Array.from({ length: 10000 }, (_, i) => ({ id: `m-${i}`, turnId: `m-${i - i % 2}`, turnHasAnswer: true,
      type: "message", role: i % 2 ? "assistant" : "user", content: `History item ${i}`, time: "12:00", cursor: String(i) }));
    const storage = { history: rows, questions: [] };
    const runtime = { provider: "codex", model: "test", effort: "low", access: "workspace-write", approval: "user", contextWindow: 128000, editable: true };
    const threads = ["history", "questions"].map(id => ({ id, space: "productivity", projectId: "p", title: id === "history" ? "万条历史" : "交互提问", status: "idle", summary: "", updatedAt: "", items: [], changes: [], usage: {}, runtime }));
    const pageOf = (id, direction = "latest", cursor) => {
      const all = storage[id];
      const pivot = Number(cursor);
      const start = direction === "latest" ? Math.max(0, all.length - 80) : direction === "before" ? Math.max(0, pivot - 80) : pivot + 1;
      const end = direction === "before" ? pivot : Math.min(all.length, start + 80);
      return { items: all.slice(start, end).map((item, i) => ({ ...item, cursor: String(start + i) })), total: all.length,
        before: String(start), after: String(end - 1), hasBefore: start > 0, hasAfter: end < all.length, revision: String(all.length) };
    };
    const load = id => { const { items, ...history } = pageOf(id); return { ...threads.find(t => t.id === id), items, history }; };
    const listeners = new Set();
    let stream;
    let finish;
    const pending = new Map();
    window.historyRequests = [];
    window.answers = [];
    window.failHistory = false;
    window.failAnswer = false;
    window.emitTest = event => {
      if (event.type === "upsert-item") {
        const all = storage[stream.threadId];
        const index = all.findIndex(i => i.id === event.item.id);
        if (index < 0) all.push(event.item); else all[index] = event.item;
      }
      for (const listener of listeners) listener({ streamId: stream.id, event });
    };
    window.askTest = provider => {
      const request = { id: `question-${pending.size}-${Date.now()}`, threadId: stream.threadId, provider, status: "pending", questions: [
        { id: "choice", header: "方向", question: "选择实现方式", multiple: false, options: [{ label: "A", description: "方式 A" }, { label: "B", description: "方式 B" }] },
        { id: "multiple", header: "范围", question: "选择范围", multiple: provider === "claude", options: [{ label: "前端", description: "界面" }, { label: "后端", description: "服务" }] },
        { id: "text", header: "说明", question: "补充说明", multiple: false, options: [] },
      ] };
      pending.set(request.id, request);
      storage[stream.threadId].push({ id: request.id, turnId: "live-turn", type: "question", request });
      window.emitTest({ type: "question-request", request });
    };
    window.cleoDesktop = {
      async request(method, params = {}, streamId) {
        if (method === "load_workspace") return { ...snapshot, projects: [{ id: "p", name: "Test", path: "fixture", space: "productivity", accent: "cyan" }], threads: [load("history"), threads[1]], activeThreadId: "history", activeSpace: "productivity", runtime };
        if (method === "get_runtime_catalog") return { nonProductivityProfiles: [], defaultNonProductivityProfile: "", defaultProductivityProvider: "codex", productivityProviders: [{ id: "codex", type: "codex_sdk", defaultModel: "test", modelSource: "config" }] };
        if (method === "get_productivity_models") return { provider: "codex", source: "sdk", models: [{ id: "test", label: "test", isDefault: true, defaultEffort: "low", supportedEfforts: ["low"] }] };
        if (method === "load_thread") return load(params.thread_id);
        if (method === "load_timeline") {
          window.historyRequests.push(params);
          if (window.failHistory) { window.failHistory = false; throw new Error("模拟历史加载失败"); }
          if (window.delayHistory) { window.delayHistory = false; await new Promise(resolve => setTimeout(resolve, 200)); }
          return pageOf(params.thread_id, params.direction, params.cursor);
        }
        if (method === "get_pending_questions") return [...pending.values()].filter(q => q.threadId === params.thread_id);
        if (method === "stream_turn") {
          stream = { id: streamId, threadId: params.thread_id };
          const user = { id: "live-turn", turnId: "live-turn", type: "message", role: "user", content: params.prompt, time: "" };
          storage[params.thread_id].push(user);
          window.emitTest({ type: "turn-started", item: user });
          await new Promise(resolve => { finish = resolve; });
          return;
        }
        if (method === "resolve_question") {
          if (window.failAnswer) { window.failAnswer = false; throw new Error("模拟提交失败"); }
          const request = pending.get(params.question_id);
          if (!request || request.threadId !== params.thread_id) throw new Error("问题已失效");
          window.answers.push(params);
          request.answers = params.answers; request.status = "answered";
          pending.delete(request.id);
          window.emitTest({ type: "question-resolved", request });
          return;
        }
        if (method === "cancel_run") {
          for (const request of pending.values()) { request.status = "cancelled"; window.emitTest({ type: "question-resolved", request }); }
          pending.clear(); finish?.(); return;
        }
        throw new Error(`Unhandled test method: ${method}`);
      },
      onStreamEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      getEvolutionState: async () => ({ phase: "idle", builds: [], releases: [], supported: false }),
      onEvolutionState: () => () => {},
      getUpdateState: async () => ({ phase: "unsupported", currentVersion: "test" }),
      onUpdateState: () => () => {}, confirmHealthy: async () => {}, setTheme: () => {},
    };
  }, { snapshot });
  await page.reload();
  await page.getByText("History item 9999", { exact: true }).waitFor();
  const inspector = page.getByTestId("inspector");
  if (await inspector.count()) await inspector.getByRole("button", { name: "关闭检查器", exact: true }).click();
  const viewport = page.locator(".conversation-viewport");
  await viewport.hover(); await page.mouse.wheel(0, -600);
  await page.waitForFunction(() => document.querySelector(".history-latest"));
  const anchored = await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const top = document.querySelector(".conversation-viewport").getBoundingClientRect().top;
    const nodes = [...document.querySelectorAll("[data-row-id]")];
    const index = nodes.findIndex(node => node.getBoundingClientRect().bottom > top + 1);
    const anchor = nodes[index];
    const original = { id: anchor.dataset.rowId, top: anchor.getBoundingClientRect().top - top };
    if (index > 0) {
      const image = document.createElement("img"); image.alt = "Delayed image";
      image.style.cssText = "display:block;width:120px;height:160px";
      nodes[index - 1].append(image);
    }
    return original;
  });
  await page.waitForFunction(({ id, top }) => {
    const row = document.querySelector(`[data-row-id="${id}"]`);
    return row && Math.abs(row.getBoundingClientRect().top - document.querySelector(".conversation-viewport").getBoundingClientRect().top - top) < 3;
  }, anchored);
  await page.getByRole("button", { name: "回到最新", exact: true }).click();
  await page.getByText("History item 9999", { exact: true }).waitFor();
  for (let i = 0; i < 140; i++) {
    const before = await page.locator("[data-cache-first]").getAttribute("data-cache-first");
    if (before === "m-0") break;
    if (i === 8) await page.evaluate(() => { window.failHistory = true; });
    await viewport.hover();
    await page.mouse.wheel(0, -10000000);
    if (i === 8) {
      await page.getByText("模拟历史加载失败", { exact: false }).waitFor();
      await page.getByRole("button", { name: "重试加载" }).click();
    }
    await page.waitForFunction(old => document.querySelector("[data-cache-first]")?.getAttribute("data-cache-first") !== old, before, { timeout: 5000 }).catch(async error => {
      console.error(await page.evaluate(() => ({ first: document.querySelector("[data-cache-first]")?.getAttribute("data-cache-first"), scroll: document.querySelector(".conversation-viewport")?.scrollTop, requests: window.historyRequests.slice(-3), text: document.querySelector(".history-error")?.textContent })));
      throw error;
    });
    assert(Number(await page.getByTestId("conversation").getAttribute("data-cache-count")) <= 500);
    assert(await page.locator("[data-row-id]").count() < 60);
  }
  assert.equal(await page.getByTestId("conversation").getAttribute("data-cache-first"), "m-0");
  await viewport.hover();
  await page.mouse.wheel(0, -10000000);
  await page.getByText("History item 0", { exact: true }).waitFor();
  for (let i = 0; i < 5; i++) {
    const first = await page.getByTestId("conversation").getAttribute("data-cache-first");
    await viewport.hover(); await page.mouse.wheel(0, 10000000);
    await page.waitForFunction(old => document.querySelector("[data-cache-first]")?.getAttribute("data-cache-first") !== old, first);
  }
  await page.getByRole("button", { name: "回到最新", exact: true }).click();
  await page.getByText("History item 9999", { exact: true }).waitFor();
  await page.evaluate(() => { window.delayHistory = true; });
  await viewport.hover(); await page.mouse.wheel(0, -10000000);
  await page.getByText("交互提问", { exact: true }).click();
  await page.waitForTimeout(250);
  assert.equal(await page.getByTestId("conversation").getAttribute("data-cache-count"), "0", "An old history response crossed thread boundaries");
  await page.getByTestId("composer-input").fill("Start");
  await page.getByTestId("send-button").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="stop-button"]'));
  const thought = { id: "thought-live", turnId: "live-turn", type: "thought", content: "正在分析当前问题", status: "done" };
  await page.evaluate(item => window.emitTest({ type: "upsert-item", item }), thought);
  await page.getByText(thought.content, { exact: true }).waitFor();
  await page.evaluate(() => window.emitTest({ type: "upsert-item", item: { id: "tool-live", turnId: "live-turn", type: "tool", name: "test", command: "test", status: "running" } }));
  assert(await page.getByText(thought.content, { exact: true }).isVisible());
  await page.evaluate(() => window.emitTest({ type: "upsert-item", item: { id: "answer-live", turnId: "live-turn", type: "message", role: "assistant", content: "最终回答", time: "" } }));
  await page.getByTestId("thought-group").getByRole("button").waitFor();
  assert.equal(await page.getByTestId("thought-group").getByRole("button").getAttribute("aria-expanded"), "false");
  await page.getByTestId("thought-group").getByRole("button").click();
  await page.evaluate(() => window.emitTest({ type: "upsert-item", item: { id: "answer-live", turnId: "live-turn", type: "message", role: "assistant", content: "最终回答继续输出", time: "" } }));
  assert.equal(await page.getByTestId("thought-group").getByRole("button").getAttribute("aria-expanded"), "true");
  await page.evaluate(() => window.askTest("claude"));
  const dialog = page.getByRole("dialog", { name: "Agent 提问" });
  await dialog.waitFor();
  const fonts = await page.evaluate(() => {
    const family = getComputedStyle(document.documentElement).fontFamily;
    return [".question-dialog", ".question-dialog textarea", ".question-dialog button"].every(selector => getComputedStyle(document.querySelector(selector)).fontFamily === family);
  });
  assert.ok(fonts, "Question controls did not inherit the established UI font");
  if (process.env.CLEO_SMOKE_OUTPUT) {
    await mkdir(process.env.CLEO_SMOKE_OUTPUT, { recursive: true });
    await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "question-dark.png") });
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "question-light.png") });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  }
  await dialog.getByRole("button", { name: "提交答案" }).click();
  assert.equal(await page.evaluate(() => window.answers.length), 0);
  await dialog.getByRole("radio", { name: /方式 A/ }).check();
  await dialog.getByRole("checkbox", { name: /前端/ }).check();
  await dialog.getByRole("checkbox", { name: /后端/ }).check();
  await dialog.locator("textarea").last().fill("保留我的输入");
  await dialog.getByRole("button", { name: "收起提问" }).click();
  await page.getByText("万条历史", { exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "回答问题", exact: true }).count(), 0);
  await page.locator(".thread-row-select").filter({ hasText: "Start" }).click();
  await page.getByRole("button", { name: "回答问题", exact: true }).click();
  assert.equal(await dialog.locator("textarea").last().inputValue(), "保留我的输入");
  await page.evaluate(() => { window.failAnswer = true; });
  await dialog.getByRole("button", { name: "提交答案" }).click();
  await dialog.getByText("模拟提交失败").waitFor();
  await dialog.getByRole("button", { name: "提交答案" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => window.answers[0].answers), { choice: ["A"], multiple: ["前端", "后端"], text: ["保留我的输入"] });
  await page.evaluate(() => window.askTest("codex"));
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "收起提问" }).click();
  await page.getByTestId("stop-button").click();
  const latest = page.getByRole("button", { name: /回到最新/ });
  if (await latest.count()) await latest.click();
  await page.getByText("提问已取消", { exact: true }).waitFor().catch(async error => {
    console.error(await page.locator(".question-history").allTextContents());
    throw error;
  });
  assert.equal(await page.getByRole("button", { name: "回答问题", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  await application.close();
  application = undefined;
  }
  if (process.env.CLEO_SMOKE_REGRESSION === "1") {
    for (const script of ["smoke.mjs", "smoke-approvals.mjs", "smoke-evolution.mjs"]) {
      const result = spawnSync(process.execPath, [join(ui, "scripts", script)], {
        cwd: ui, stdio: "inherit", windowsHide: true,
        env: { ...process.env, CLEO_SMOKE_APP_DIR: appDir, CLEO_SMOKE_OUTPUT: join(scratch, script), CLEO_HOME: join(scratch, "home") },
      });
      assert.equal(result.status, 0, `${script} failed`);
    }
  }
  console.log(JSON.stringify({ status: "passed", history: !process.argv.includes("--regression-only"), regression: process.env.CLEO_SMOKE_REGRESSION === "1" }));
} finally {
  if (application) await application.close();
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
