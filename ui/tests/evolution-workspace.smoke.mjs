import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { snapshot } from "../src/services/mockData.ts";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "cleo-workspace-smoke-"));
const server = await createServer({ root: ui, cacheDir: join(scratch, "vite"), server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(fixture => {
    localStorage.setItem("cleo-view", "evolution");
    const control = window.evolutionTest = { calls: [], installs: [], next: null, installFail: true };
    const thread = fixture.threads[0];
    thread.projectId = "productivity:cleo-evolution"; thread.space = "productivity"; thread.items = [];
    thread.runtime = fixture.runtime;
    fixture.projects.push({ id: thread.projectId, space: "productivity", name: "Cleo", path: "C:\\Cleo\\source", accent: "cyan", dirtyFiles: 0 });
    const state = { phase: "idle", supported: true, prepared: true, threadId: thread.id, active: "old", baseline: "old", builds: [{ id: "old", kind: "local", name: "当前版本" }], releases: [], iteration: { base: "old" },
      acceptance: { fresh: false, cases: [{ id: "old-case", enabled: true, kind: "manual" }] } };
    const setup = { showOnStartup: true, busy: false, checking: false, dismissed: false, message: "", logs: "", items: [
      { id: "runtime", title: "Cleo 基础运行环境", ready: true, detail: "Python 已就绪", optional: false, action: "修复运行环境" },
      { id: "docker", title: "Docker Desktop", ready: false, detail: "独立桌面使用；普通聊天可以跳过。", optional: true, action: "安装 Docker" },
    ] };
    let listener;
    window.cleoDesktop = {
      setup: async (action, params) => {
        if (action === "dismiss") setup.dismissed = true;
        if (action === "install") {
          control.installs.push(params);
          if (control.installFail) throw new Error("下载中断，可以重试");
          setup.items[1].ready = true;
        }
        return structuredClone(setup);
      },
      request: async (method, params = {}, streamId) => {
        control.calls.push({ method, params });
        if (method === "load_workspace") return structuredClone(fixture);
        if (method === "open_evolution_thread") return { thread: structuredClone(thread), workspace: structuredClone(fixture) };
        if (method === "load_thread") return structuredClone(fixture.threads.find(item => item.id === params.thread_id));
        if (method === "load_memory") return { memories: fixture.memories, memoryOverview: fixture.memoryOverview };
        if (["get_pending_questions", "get_local_skills"].includes(method)) return [];
        if (method === "get_runtime_catalog") return { nonProductivityProfiles: [], productivityProviders: [], defaultProductivityProvider: "codex", defaultNonProductivityProfile: "" };
        if (method === "get_productivity_models") return { provider: "codex", source: "sdk", models: [] };
        if (method === "get_model_settings") return { profiles: [], connections: [], activeAgent: "", activeDreamAgent: "" };
        if (method === "get_agent_instructions") return { content: "", path: "AGENTS.md", exists: false };
        if (method === "stream_turn") {
          if (control.next?.id === params.run_id) control.next = null;
          listener?.({ streamId, event: { type: "done" } }); return null;
        }
        throw new Error(`Unhandled request ${method}`);
      },
      evolutionAction: async (action, params) => {
        control.calls.push({ action, params });
        if (action === "nextMessage") return control.next;
        if (action === "thread") return null;
        if (action === "build") {
          state.candidate = "new"; state.validation = { status: "passed", sourceHash: "source", candidate: "new", message: "已通过" };
          state.builds.push({ id: "new", kind: "local", sourceHash: "source" }); return "new";
        }
        if (action === "apply") { state.active = "new"; return true; }
        if (action === "save") return true;
        throw new Error(`Unexpected evolution planning/action ${action}`);
      },
      getEvolutionState: async () => structuredClone(state), onEvolutionState: () => () => {}, confirmHealthy: async () => {},
      getUpdateState: async () => ({ phase: "unsupported", currentVersion: "0.5.15" }), onUpdateState: () => () => {},
      onStreamEvent: callback => { listener = callback; return () => { listener = null; }; },
    };
  }, snapshot);
  await page.goto(server.resolvedUrls.local[0]);
  const setup = page.getByRole("dialog", { name: "运行环境", exact: true });
  await setup.waitFor();
  assert.equal(await page.evaluate(() => window.evolutionTest.installs.length), 0);
  await setup.getByRole("checkbox", { name: "安装 Docker", exact: true }).check();
  const install = setup.getByRole("button", { name: "安装所选依赖", exact: true });
  assert.equal(await install.isDisabled(), true);
  await setup.getByRole("checkbox", { name: /允许下载并安装/ }).check();
  await install.click();
  await setup.getByRole("alert").getByText("下载中断，可以重试", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.evolutionTest.installs[0]), { ids: ["docker"], consent: true });
  if (process.env.CLEO_SMOKE_OUTPUT) await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "dependency-setup.png") });
  await setup.getByRole("button", { name: "稍后再说", exact: true }).click();
  const composer = page.getByTestId("composer-input");
  await composer.fill("调整输入框间距，之后再讨论颜色"); await composer.press("Enter");
  await page.waitForFunction(() => window.evolutionTest.calls.some(call => call.method === "stream_turn"));
  assert.equal(await page.evaluate(() => window.evolutionTest.calls.find(call => call.method === "stream_turn").params.prompt), "调整输入框间距，之后再讨论颜色");
  assert.equal(await page.evaluate(() => window.evolutionTest.calls.some(call => call.action === "prepareRequest" || call.action === "build")), false);
  assert.equal(await page.getByText("验收清单", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "检查改动", exact: true }).click();
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await page.getByRole("button", { name: "保存", exact: true }).waitFor();
  if (process.env.CLEO_SMOKE_OUTPUT) await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "evolution-workspace.png") });
  assert.deepEqual(errors, []);
  console.log("PASS: setup consent/failure/skip, direct evolution conversation, no automatic build or behavior gate and save after application");
} finally {
  await browser?.close(); await server.close();
  assert.equal(dirname(scratch), resolve(tmpdir()));
  await rm(scratch, { recursive: true, force: true });
}
