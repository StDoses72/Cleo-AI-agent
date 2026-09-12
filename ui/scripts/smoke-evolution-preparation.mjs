import assert from "node:assert/strict";
import { _electron as electron, chromium } from "playwright";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { snapshot as fixtureWorkspace } from "../src/services/mockData.ts";
import { EvolutionStore } from "../electron/evolution-store.mjs";
import { EvolutionAcceptance } from "../electron/evolution-acceptance.mjs";
import { EvolutionRequests } from "../electron/evolution-requests.mjs";
import { runPreparedEvolutionTurn } from "../electron/evolution-editing.mjs";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "cleo-preparation-ui-"));
const output = join(ui, "output/playwright/evolution");
let server;
let url;
let application;
let page;
if (process.env.CLEO_TEST_BROWSER) {
  server = createServer(async (req, res) => {
    const name = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const path = resolve(ui, "dist", name === "/" ? "index.html" : `.${name}`);
    if (!path.startsWith(resolve(ui, "dist") + "/") && !path.startsWith(resolve(ui, "dist") + "\\")) { res.writeHead(403); res.end(); return; }
    try {
      res.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".html") ? "text/html" : "application/octet-stream");
      res.end(await readFile(path));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  url = `http://127.0.0.1:${server.address().port}`;
  application = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER, headless: true });
  page = await application.newPage({ viewport: { width: 1280, height: 900 } });
} else {
  application = await electron.launch({ args: [".", `--user-data-dir=${join(root, "profile")}`], cwd: ui,
    env: { ...process.env, CLEO_DESKTOP_MOCK: "1" } });
  page = await application.firstWindow();
}
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const actions = [];
let modelFails = false;
let releaseAnalysis;
let holdAnalysis = false;
const workspace = structuredClone(fixtureWorkspace);
const runtime = { provider: "codex", model: "test", effort: "low", access: "workspace-write", approval: "deny_all", editable: true };
const thread = { ...workspace.threads[0], id: "evolution-test", projectId: "productivity:cleo-evolution",
  space: "productivity", title: "Cleo 自我迭代", items: [], changes: [], status: "idle", runtime };
workspace.threads = [thread]; workspace.activeThreadId = thread.id;
workspace.projects = [{ id: thread.projectId, space: "productivity", name: "Cleo", path: "fixture", accent: "cyan" }];
const state = { phase: "idle", supported: true, prepared: true, currentVersion: "0.3.9", active: "old",
  baseline: "old", candidate: null, source: "fixture", threadId: thread.id, error: null, logs: "", iteration: null,
  builds: [{ id: "old", kind: "local", sourceHash: "old", savedAt: "saved" }, { id: "new", kind: "local", sourceHash: "new" }],
  releases: [], pullRequest: null };
const store = new EvolutionStore(join(root, "evolution"), join(root, "data"));
store.read = async () => state;
store.build = async (id) => state.builds.find((b) => b.id === id);
const acceptance = new EvolutionAcceptance(store);
const requests = new EvolutionRequests(acceptance, async (_thread, prompt) => {
  if (holdAnalysis) await new Promise((resolve) => { releaseAnalysis = resolve; });
  if (modelFails) throw new Error("测试连接暂不可用；原需求已保留");
  if (prompt.includes("解释")) return { intent: "question", answer: "这个按钮打开侧栏，没有启动代码修改。", cases: [] };
  return { intent: "change", cases: [{ title: "侧栏显示文字", requirement: prompt,
    current: "尚未验证（静态分析）：当前显示图标", trigger: "打开侧栏", expectation: "看到按钮文字",
    evidence: "ui/src/Button.tsx:1: <button />" }] };
});
const snapshot = async () => ({ ...state, acceptance: await acceptance.status(state), acceptanceRequests: await requests.status() });
const publish = async () => page.evaluate((value) => window.testEvolutionListener?.(value), await snapshot());
const evolution = {
  operation: (_phase, action) => store.exclusive(action),
  begin: async () => { actions.push("begin"); state.iteration = { base: "old" }; state.draftDirty = true; },
  build: async () => { actions.push("build"); state.candidate = "new"; state.draftDirty = false;
    state.validation = { status: "passed", sourceHash: "new", candidate: "new", message: "隔离测试构建完成" }; return "new"; },
};
try {
  await page.exposeFunction("testEvolutionSnapshot", snapshot);
  await page.exposeFunction("testEvolutionAction", async (action, params) => {
    actions.push(action);
    try {
      if (action === "thread") { state.threadId = params.id; return; }
      if (action === "prepareRequest") return await store.exclusive(() => requests.prepare(params));
      if (action === "reviseRequest") return await store.exclusive(() => requests.revise(params));
      if (action === "requestPrompt") return requests.editingPrompt(params.id);
      throw new Error("Unexpected evolution action: " + action);
    } finally { await publish(); }
  });
  await page.exposeFunction("testDesktopRequest", async (method, params, streamId) => {
    if (method === "load_workspace") return workspace;
    if (method === "get_runtime_catalog") return { nonProductivityProfiles: [], productivityProviders: [
      { id: "codex", label: "Codex", defaultModel: "test", models: ["test"], efforts: ["low"] }],
      defaultProductivityProvider: "codex", defaultNonProductivityProfile: "" };
    if (method === "get_productivity_models") return { provider: "codex", models: [], efforts: [] };
    if (method === "load_thread") return thread;
    if (method === "open_evolution_thread") return { thread, workspace };
    if (method === "stream_turn") {
      actions.push("stream_turn");
      const events = [];
      await runPreparedEvolutionTurn({ evolution, requests, acceptance, params, onEvent: (event) => events.push(event),
        backend: { request: async (_method, _params, emit) => {
          assert.equal((await requests.read()).requests.at(-1).status, "frozen");
          emit({ type: "done", summary: "隔离测试编辑结束" }); thread.status = "completed";
        } } });
      for (const event of events) await page.evaluate((payload) => window.testStreamListener?.(payload), { streamId, event });
      await publish(); return null;
    }
    throw new Error("Unexpected backend request: " + method);
  });
  await page.addInitScript(() => {
    localStorage.setItem("cleo-view", "evolution");
    window.cleoDesktop = {
      request: (...args) => window.testDesktopRequest(...args),
      getEvolutionState: () => window.testEvolutionSnapshot(),
      evolutionAction: (...args) => window.testEvolutionAction(...args),
      onEvolutionState: (listener) => { window.testEvolutionListener = listener; return () => {}; },
      onStreamEvent: (listener) => { window.testStreamListener = listener; return () => {}; },
      confirmHealthy: async () => {},
      getUpdateState: async () => ({ status: "idle", currentVersion: "0.3.9" }),
      onUpdateState: () => () => {},
    };
  });
  if (url) await page.goto(url); else await page.reload();
  await page.getByTestId("composer-input").waitFor();
  holdAnalysis = true;
  await page.getByTestId("composer-input").fill("给侧栏按钮显示文字");
  await page.getByTestId("composer-input").press("Enter");
  await page.getByText("正在分析需求并准备验收…", { exact: true }).waitFor();
  assert.ok(!actions.includes("begin"));
  await page.waitForFunction(() => document.querySelector('[aria-label="本轮验收准备"]'));
  while (!releaseAnalysis) await new Promise((done) => setTimeout(done, 10));
  holdAnalysis = false; releaseAnalysis();
  await page.getByRole("region", { name: "本轮验收准备" }).getByText("看到按钮文字", { exact: true }).first().waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="本轮验收准备"]').textContent.includes("实现任务已结束"));
  assert.deepEqual(actions.filter((a) => ["prepareRequest", "requestPrompt", "stream_turn", "begin", "build"].includes(a)),
    ["prepareRequest", "requestPrompt", "stream_turn", "begin", "build"]);
  assert.ok(await page.getByRole("button", { name: "应用", exact: true }).isDisabled());
  assert.match(await page.getByRole("region", { name: "本轮验收准备" }).textContent(), /待人工验收/);
  assert.equal((await requests.suite())[0].kind, "manual");
  await mkdir(output, { recursive: true });
  await page.locator(".conversation-viewport").evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: join(output, "automatic-acceptance-prepared.png"), fullPage: true });
  const originalId = (await requests.read()).requests[0].id;
  await page.reload();
  await page.getByRole("region", { name: "本轮验收准备" }).getByText("看到按钮文字", { exact: true }).first().waitFor();
  assert.equal((await requests.read()).requests[0].id, originalId);
  assert.equal(actions.filter((a) => a === "build").length, 1);

  await page.getByTestId("composer-input").fill("解释这个按钮，不要修改代码");
  await page.getByTestId("composer-input").press("Enter");
  await page.getByText("这个按钮打开侧栏，没有启动代码修改。", { exact: true }).waitFor();
  assert.equal(actions.filter((a) => a === "build").length, 1);
  assert.equal((await requests.suite()).length, 1);

  modelFails = true;
  await page.getByTestId("composer-input").fill("将侧栏文字加粗");
  await page.getByTestId("composer-input").press("Enter");
  await page.getByRole("button", { name: "重试准备原需求", exact: true }).waitFor();
  const failed = (await requests.read()).requests.at(-1);
  assert.equal(failed.prompt, "将侧栏文字加粗");
  await page.reload();
  await page.getByRole("button", { name: "重试准备原需求", exact: true }).waitFor();
  assert.equal(actions.filter((a) => a === "build").length, 1);
  modelFails = false;
  await page.getByRole("button", { name: "重试准备原需求", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.evolution-request')].at(-1)?.textContent.includes("实现任务已结束"));
  assert.equal((await requests.read()).requests.at(-1).id, failed.id);
  assert.equal((await requests.suite()).length, 2);

  await page.getByRole("button", { name: "修正案例", exact: true }).last().click();
  await page.getByLabel("修正后的预期", { exact: true }).fill("文字加粗且保留标签");
  await page.getByLabel("变更原因", { exact: true }).fill("补充不删除标签的要求");
  await page.getByRole("button", { name: "保留旧案例并保存修正", exact: true }).click();
  await page.locator(".evolution-request dd").filter({ hasText: /^文字加粗且保留标签$/ }).waitFor();
  assert.equal((await requests.suite()).length, 3);
  assert.equal((await acceptance.status(state)).fresh, false);
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: join(output, "automatic-acceptance.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "passed", scenarios: 6, checks: "prepare-before-edit, manual-gate, reload, question, failure-retry, revision", output }));
} catch (error) {
  console.error(JSON.stringify({ errors, body: await page.locator("body").innerText().catch(() => "unavailable"), actions }));
  throw error;
} finally {
  await application.close();
  if (server) await new Promise((done) => server.close(done));
  assert.equal(dirname(root), resolve(tmpdir()));
  await rm(root, { recursive: true, force: true });
}
