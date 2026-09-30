import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { snapshot } from "../src/services/mockData.ts";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "cleo-timing-"));
const server = await createServer({ root: ui, cacheDir: join(scratch, "vite"), server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript(seed => {
    const fixture = structuredClone(seed);
    const now = new Date().toISOString();
    const summary = { id: "measured", sessionId: "desktop-ui", turnId: "turn-1", space: "productivity",
      project: "Cleo", kind: "reply", status: "completed", elapsedMs: 12500, phase: null,
      createdAt: now, updatedAt: now, unavailable: ["模型服务内部阶段"], persistenceError: null };
    const thread = fixture.threads.find(item => item.id === "desktop-ui");
    thread.items = [
      { id: "old", turnId: "old", type: "message", role: "assistant", content: "旧回复", time: "" },
      { id: "turn-1", turnId: "turn-1", type: "message", role: "user", content: "检查界面", time: "" },
      { id: "answer", turnId: "turn-1", type: "message", role: "assistant", content: "已整理当前界面。", time: "", timing: summary },
    ];
    thread.currentTiming = summary;
    fixture.activeThreadId = thread.id;
    fixture.activeSpace = "productivity";
    fixture.memoryOverview.timings = [{ ...summary, id: "dream", kind: "dream", title: "界面调整", status: "failed" }];
    const listeners = new Set();
    const state = window.timingTest = { requests: [], fail: false, summary, thread, fixture };
    window.cleoDesktop = {
      request: async (method, params = {}, streamId) => {
        if (method === "load_workspace") return structuredClone(fixture);
        if (method === "load_thread") return structuredClone(thread);
        if (method === "load_memory") return structuredClone({ memories: fixture.memories, memoryOverview: fixture.memoryOverview });
        if (method === "get_timing") {
          state.requests.push(params.timing_id);
          if (state.fail) { state.fail = false; throw new Error("计时读取暂时失败"); }
          const value = params.timing_id === "dream" ? fixture.memoryOverview.timings[0]
            : params.timing_id === "old-attempt" ? { ...summary, id: "old-attempt", status: "cancelled", elapsedMs: 3000 } : summary;
          return { ...value, accumulatedMs: 15500, attempts: [{ ...summary, id: "old-attempt", status: "cancelled", elapsedMs: 3000 },
            params.timing_id === "dream" ? fixture.memoryOverview.timings[0] : summary],
            spans: [{ id: "1", label: "准备上下文", category: "stage", parentId: null, status: "completed", elapsedMs: 500 },
              { id: "2", label: "模型请求", category: "model", parentId: null, status: "completed", elapsedMs: 11000 },
              { id: "3", label: "保存结果", category: "stage", parentId: null, status: value.status, elapsedMs: 1000 }] };
        }
        if (method === "get_pending_questions" || method === "get_local_skills") return [];
        if (method === "get_runtime_catalog") return { nonProductivityProfiles: [], defaultNonProductivityProfile: "", defaultProductivityProvider: "codex", productivityProviders: [] };
        if (method === "get_productivity_models") return { provider: "codex", source: "sdk", models: [] };
        if (method === "stream_turn") return new Promise(resolve => {
          summary.id = "live-attempt"; summary.turnId = "live-turn";
          state.finish = () => {
            summary.status = "completed"; summary.phase = null;
            for (const callback of listeners) callback({ streamId, event: { type: "timing", timing: structuredClone(summary) } });
            for (const callback of listeners) callback({ streamId, event: { type: "done", summary: "完成" } });
            resolve();
          };
          state.tick = value => {
            summary.elapsedMs = value; summary.status = "running"; summary.phase = "等待审批";
            for (const callback of listeners) callback({ streamId, event: { type: "timing", timing: structuredClone(summary) } });
          };
          for (const callback of listeners) callback({ streamId, event: { type: "turn-started",
            item: { ...thread.items[1], id: "live-turn", turnId: "live-turn" } } });
          state.tick(1000);
        });
        throw new Error(`Unexpected timing fixture method: ${method}`);
      },
      onStreamEvent: callback => { listeners.add(callback); return () => listeners.delete(callback); },
      getEvolutionState: async () => ({ phase: "idle", supported: false, builds: [], releases: [] }),
      onEvolutionState: () => () => {}, confirmHealthy: async () => {},
      getUpdateState: async () => ({ phase: "unsupported", currentVersion: "0.4.8" }), onUpdateState: () => () => {},
    };
  }, snapshot);
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByText("耗时未记录", { exact: true }).first().waitFor();
  const timing = page.locator(".conversation-shell .timing").first();
  assert.equal(await page.evaluate(() => window.timingTest.requests.length), 0, "Collapsed diagnostics loaded eagerly");
  await timing.locator("summary").click();
  await timing.getByText("最慢", { exact: true }).waitFor();
  await timing.getByLabel("查看计时尝试").selectOption("old-attempt");
  await timing.getByText("本次 3.0 秒 · 已取消", { exact: true }).waitFor();
  await timing.getByLabel("查看计时尝试").selectOption("measured");
  await timing.getByText("本次 13 秒 · 已完成", { exact: true }).waitFor();
  await page.setViewportSize({ width: 760, height: 800 });
  if (!await page.getByTestId("inspector").count()) await page.getByRole("button", { name: "打开检查器", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".conversation-shell").getBoundingClientRect().width >= 350);
  assert.equal(await page.locator(".thread-sidebar").isVisible(), false);
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await page.getByTestId("inspector").waitFor({ state: "detached" });
  assert.equal(await page.locator(".thread-sidebar").isVisible(), true);
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    assert.equal(await timing.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    if (process.env.CLEO_SMOKE_OUTPUT) await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, `timing-${theme}.png`) });
  }
  await page.getByTestId("composer-input").fill("继续");
  await page.getByTestId("send-button").click();
  await page.getByText("等待审批 · 1.0 秒", { exact: true }).waitFor();
  await page.evaluate(() => window.timingTest.tick(2500));
  await page.getByText("等待审批 · 2.5 秒", { exact: true }).waitFor();
  await page.evaluate(() => window.timingTest.finish());
  await page.getByTestId("send-button").waitFor();
  await page.getByRole("button", { name: "记忆", exact: true }).click();
  await page.locator(".memory-timing-history > summary").click();
  await page.evaluate(() => { window.timingTest.fail = true; });
  const dream = page.locator(".memory-timing-history .timing");
  await dream.locator("summary").click();
  await dream.getByText("计时读取暂时失败", { exact: false }).waitFor();
  await dream.getByRole("button", { name: "重试", exact: true }).click();
  await dream.getByText("本次 13 秒 · 失败", { exact: true }).waitFor();
  if (process.env.CLEO_SMOKE_OUTPUT) await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "timing-memory.png") });
  assert.deepEqual(errors, []);
  console.log("PASS: measured summaries, lazy details, attempts, live updates, old records, memory failure/retry, narrow layout and themes");
} finally {
  await browser?.close(); await server.close();
  assert.equal(dirname(scratch), resolve(tmpdir()));
  await rm(scratch, { recursive: true, force: true });
}
