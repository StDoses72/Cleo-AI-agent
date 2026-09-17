import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { snapshot } from "../src/services/mockData.ts";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "cleo-steering-"));
const server = await createServer({ root: ui, cacheDir: join(scratch, "vite"), server: { host: "127.0.0.1", port: 0 } });
let browser;
let page;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER, headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(seed => {
    const saved = sessionStorage.getItem("steer-fixture");
    const fixture = saved ? JSON.parse(saved) : seed;
    if (!saved) {
      for (const thread of fixture.threads) {
        thread.runtime = { ...fixture.runtime, provider: "codex",
          steerMode: thread.id === "session-hub" ? "boundary" : "native" };
        thread.items = Array.from({ length: 100 }, (_, index) => ({
          id: `${thread.id}:old:${index}`, type: "message", role: index % 2 ? "assistant" : "user",
          content: `旧记录 ${index}\n\n${"用于验证阅读历史时不会被新状态拉回底部。".repeat(5)}`, time: "",
          order: index + 1, cursor: String(index + 1),
        }));
        thread.history = { before: "1", after: "100", total: 100, hasBefore: false, hasAfter: false, revision: "100" };
      }
    }
    const listeners = new Set();
    const control = window.steerTest = { calls: [], injections: [], runs: new Map(), receipts: new Map(),
      holdNext: false, dropNext: false, failNext: false, suppressNext: false, release: null, fixture };
    for (const thread of fixture.threads) for (const item of thread.items) if (item.steer) {
      control.receipts.set(item.steer.id, structuredClone(item.steer));
    }
    const threadOf = id => fixture.threads.find(t => t.id === id);
    const upsert = (thread, item) => {
      const index = thread.items.findIndex(existing => existing.id === item.id);
      const record = { ...item, order: index < 0 ? thread.items.length + 1 : index + 1,
        cursor: String(index < 0 ? thread.items.length + 1 : index + 1) };
      if (index < 0) thread.items.push(record); else thread.items[index] = record;
      return record;
    };
    const emit = (id, event) => {
      const run = control.runs.get(id);
      if (!run) return;
      if (event.type === "upsert-item" || event.type === "turn-started") event.item = upsert(threadOf(id), event.item);
      for (const listener of listeners) listener({ streamId: run.streamId, event: structuredClone(event) });
    };
    const view = receipt => ({ id: `steer-${receipt.id}`, type: "message", role: "user",
      content: receipt.text, time: "", turnId: receipt.turnId, steer: structuredClone(receipt) });
    const update = (receipt, changes, suppress = false) => {
      Object.assign(receipt, changes, { revision: receipt.revision + 1 });
      const item = upsert(threadOf(receipt.threadId), view(receipt));
      if (!suppress) emit(receipt.threadId, { type: "upsert-item", item });
      return item;
    };
    control.finish = (id, cancel = false) => {
      const run = control.runs.get(id);
      for (const receipt of control.receipts.values()) if (receipt.threadId === id && ["queued", "sending"].includes(receipt.status)) {
        update(receipt, { status: cancel ? "cancelled" : "received", error: cancel ? "运行已停止，指令未投递。" : null });
      }
      emit(id, cancel ? { type: "error", message: "当前运行已取消。" } : { type: "done", summary: "finished" });
      Object.assign(threadOf(id), { status: "completed", activeRunId: null, steerReady: false });
      control.runs.delete(id);
      run.resolve();
    };
    const pageOf = (id, direction = "latest", cursor) => {
      const rows = threadOf(id).items.map((item, index) => ({ ...item, order: index + 1, cursor: String(index + 1) }));
      const pivot = Number(cursor);
      const start = direction === "after" ? pivot : direction === "before" ? Math.max(0, pivot - 81) : Math.max(0, rows.length - 80);
      const end = direction === "before" ? pivot - 1 : Math.min(rows.length, start + 80);
      return { items: rows.slice(start, end), before: String(start + 1), after: String(end),
        total: rows.length, hasBefore: start > 0, hasAfter: end < rows.length, revision: String(rows.length) };
    };
    window.cleoDesktop = {
      request: async (method, params = {}, streamId) => {
        if (method === "load_workspace") return structuredClone(fixture);
        if (method === "load_memory") return { memories: fixture.memories, memoryOverview: fixture.memoryOverview };
        if (method === "load_thread") return structuredClone(threadOf(params.thread_id));
        if (method === "load_timeline") return pageOf(params.thread_id, params.direction, params.cursor);
        if (method === "get_pending_questions" || method === "get_local_skills") return [];
        if (method === "get_runtime_catalog") return { nonProductivityProfiles: [], defaultNonProductivityProfile: "", defaultProductivityProvider: "codex", productivityProviders: [] };
        if (method === "get_productivity_models") return { provider: "codex", source: "sdk", models: [] };
        if (method === "stream_turn") return new Promise(resolve => {
          const thread = threadOf(params.thread_id);
          const run = { runId: params.run_id, streamId, resolve, turnId: `turn-${params.run_id}` };
          control.runs.set(thread.id, run);
          Object.assign(thread, { status: "running", activeRunId: params.run_id, steerReady: true });
          emit(thread.id, { type: "turn-started", item: { id: run.turnId, turnId: run.turnId,
            type: "message", role: "user", content: params.prompt, time: "" } });
        });
        if (method === "cancel_run") {
          if (control.runs.get(params.thread_id)?.runId !== params.run_id) return { cancelled: false };
          control.finish(params.thread_id, true); return { cancelled: true };
        }
        if (method === "steer_run") {
          control.calls.push(structuredClone(params));
          let receipt = control.receipts.get(params.request_id);
          if (receipt && !(params.retry && receipt.retryable)) return upsert(threadOf(receipt.threadId), view(receipt));
          const run = control.runs.get(params.thread_id);
          if (!receipt) {
            receipt = { id: params.request_id, threadId: params.thread_id, runId: params.run_id,
              turnId: run?.turnId, text: params.text, mode: threadOf(params.thread_id).runtime.steerMode,
              status: "queued", revision: -1, retryable: false, createdAt: new Date().toISOString() };
            control.receipts.set(receipt.id, receipt);
          }
          const suppress = control.suppressNext;
          control.suppressNext = false;
          const response = update(receipt, { status: "queued", error: null }, suppress);
          if (control.failNext) {
            control.failNext = false;
            update(receipt, { status: "failed", retryable: true, error: "后端拒绝了本次投递" }, suppress);
          } else if (receipt.mode === "native") {
            control.injections.push({ id: receipt.id, threadId: receipt.threadId, text: receipt.text });
            update(receipt, { status: "received", retryable: false }, suppress);
          }
          if (control.dropNext) { control.dropNext = false; throw new Error("传输连接中断"); }
          if (control.holdNext) {
            control.holdNext = false;
            await new Promise(resolve => { control.release = resolve; });
          }
          return response;
        }
        throw new Error(`Unhandled fixture method: ${method}`);
      },
      onStreamEvent: callback => { listeners.add(callback); return () => listeners.delete(callback); },
      getEvolutionState: async () => ({ phase: "idle", supported: false, builds: [], releases: [] }),
      onEvolutionState: () => () => {}, confirmHealthy: async () => {},
      getUpdateState: async () => ({ phase: "unsupported", currentVersion: "0.4.8" }),
      onUpdateState: () => () => {},
    };
  }, snapshot);
  await page.goto(server.resolvedUrls.local[0]);
  const input = page.getByTestId("composer-input");
  const steer = page.getByTestId("steer-button");
  const send = async text => {
    await input.fill(text);
    await steer.and(page.locator(":enabled")).waitFor();
    await steer.click();
  };
  await input.fill("原始任务：修改前端");
  await page.getByTestId("send-button").click();
  await steer.waitFor();
  await input.fill("中文输入仍在组合");
  await input.evaluate(el => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
  assert.equal(await page.evaluate(() => window.steerTest.calls.length), 0);
  await page.evaluate(() => { window.steerTest.holdNext = true; });
  await send("先不要改样式，只处理历史加载逻辑");
  await page.waitForFunction(() => Boolean(window.steerTest.release));
  await page.getByTestId("steer-receipt").getByText("运行时已接收", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("stop-button").isEnabled(), true);
  await input.fill("A 尚未发送的草稿");
  await page.getByRole("button", { name: /^统一 managed 与 native sessions/ }).click();
  await input.fill("B 尚未发送的草稿");
  await page.evaluate(() => window.steerTest.release());
  await page.waitForTimeout(80);
  assert.equal(await input.inputValue(), "B 尚未发送的草稿", "A receipt changed the current task's draft");
  await page.getByRole("button", { name: /^完成独立桌面 UI/ }).click();
  assert.equal(await input.inputValue(), "A 尚未发送的草稿");
  assert.equal(await page.getByTestId("steer-receipt").getAttribute("data-status"), "received", "Late queued receipt replaced the runtime acknowledgement");
  await send("保留原目标和已有进度");
  await page.waitForFunction(() => window.steerTest.injections.length === 2);
  assert.deepEqual(await page.evaluate(() => window.steerTest.injections.map(i => i.text)), [
    "先不要改样式，只处理历史加载逻辑", "保留原目标和已有进度",
  ]);

  await page.evaluate(() => { window.steerTest.dropNext = true; window.steerTest.suppressNext = true; });
  await send("断线后也只能投递一次");
  await page.getByRole("alert").getByText(/传输连接中断/).waitFor();
  assert.equal(await input.inputValue(), "断线后也只能投递一次");
  await steer.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="composer-input"]').value === "");
  assert.equal(await page.evaluate(() => window.steerTest.injections.length), 3);
  assert.equal(await page.evaluate(() => {
    const calls = window.steerTest.calls; return calls.at(-1).request_id === calls.at(-2).request_id;
  }), true);

  await page.evaluate(() => { window.steerTest.failNext = true; });
  await send("可以安全重试的指令");
  const failed = page.getByTestId("steer-receipt").filter({ hasText: "后端拒绝了本次投递" });
  await failed.waitFor();
  await input.fill("重试时保留这份草稿");
  await failed.getByRole("button", { name: "重试", exact: true }).click();
  await failed.waitFor({ state: "hidden" });
  assert.equal(await input.inputValue(), "重试时保留这份草稿");

  await page.getByRole("button", { name: /^统一 managed 与 native sessions/ }).click();
  await input.fill("B 的原始任务");
  await page.getByTestId("send-button").click();
  await send("B 在本轮结束后接收的指令");
  await page.getByTestId("steer-receipt").getByText("当前回复结束后发送", { exact: true }).waitFor();
  await page.getByTestId("stop-button").click();
  const cancelled = page.getByTestId("steer-receipt").filter({ hasText: "已取消投递" });
  await cancelled.waitFor();
  await input.fill("已有草稿");
  const beforeRestore = await page.evaluate(() => window.steerTest.calls.length);
  await cancelled.getByRole("button", { name: "放回输入框", exact: true }).click();
  assert.equal(await input.inputValue(), "已有草稿\n\nB 在本轮结束后接收的指令");
  assert.equal(await page.evaluate(() => window.steerTest.calls.length), beforeRestore);
  assert.equal(await page.evaluate(() => window.steerTest.runs.has("desktop-ui")), true);

  await page.getByRole("button", { name: /^完成独立桌面 UI/ }).click();
  const viewport = page.getByLabel("对话历史", { exact: true });
  await viewport.evaluate(el => { el.scrollTop = 500; el.dispatchEvent(new Event("scroll")); });
  await page.waitForTimeout(100);
  const position = await viewport.evaluate(el => el.scrollTop);
  await send("阅读历史时补充要求");
  await page.waitForFunction(() => window.steerTest.injections.some(i => i.text === "阅读历史时补充要求"));
  await page.waitForTimeout(100);
  assert.ok(Math.abs(await viewport.evaluate(el => el.scrollTop) - position) < 3, "Steer acknowledgement stole the reading position");
  await page.getByRole("button", { name: "回到最新", exact: true }).click();
  await page.getByText("阅读历史时补充要求", { exact: true }).waitFor();
  if (process.env.CLEO_SMOKE_OUTPUT) await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "steer-running.png") });
  await page.evaluate(() => {
    window.steerTest.finish("desktop-ui");
    sessionStorage.setItem("steer-fixture", JSON.stringify(window.steerTest.fixture));
  });
  await page.getByTestId("stop-button").waitFor({ state: "hidden" });
  await page.reload();
  await input.waitFor();
  await page.getByText("阅读历史时补充要求", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("steer-receipt").last().getAttribute("data-status"), "received");
  assert.deepEqual(errors, []);
  console.log("PASS: native/boundary steering, independent stop, FIFO input, late receipts, idempotent retry, task isolation, preserved drafts, cancellation, history anchoring and reload");
} catch (error) {
  if (page && process.env.CLEO_SMOKE_OUTPUT) await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "steer-failure.png") });
  if (page) console.log(await page.evaluate(() => ({ receipts: [...window.steerTest.receipts.values()],
    visible: [...document.querySelectorAll('[data-testid="steer-receipt"]')].map(e => e.textContent),
    scroll: document.querySelector('.conversation-viewport')?.scrollTop,
  })));
  throw error;
} finally {
  await browser?.close(); await server.close();
  assert.equal(dirname(scratch), resolve(tmpdir()));
  await rm(scratch, { recursive: true, force: true });
}
