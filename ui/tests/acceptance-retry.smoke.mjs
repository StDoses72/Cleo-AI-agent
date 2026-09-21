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
const output = join(process.env.CLEO_SMOKE_OUTPUT || join(ui, "output/playwright"), "acceptance-retry");
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
  application = await electron.launch({
    executablePath: process.env.CLEO_TEST_EXECUTABLE,
    args: [...(process.env.CLEO_TEST_EXECUTABLE ? [] : ["."]), `--user-data-dir=${join(root, "profile")}`], cwd: ui,
    env: { ...process.env, CLEO_DESKTOP_MOCK: "1", CLEO_HOME: join(root, "data") } });
  page = await application.firstWindow();
}
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const actions = [];
const submissions = [];
let modelFails = false;
let releaseAnalysis;
let holdAnalysis = false;
let missingEvidence = false;
let branchReady = false;
const workspace = structuredClone(fixtureWorkspace);
const runtime = { provider: "codex", model: "test", effort: "low", access: "workspace-write", approval: "deny_all", editable: true };
let thread = { ...workspace.threads[0], id: "evolution-test", projectId: "productivity:cleo-evolution",
  space: "productivity", title: "Cleo 自我迭代", items: [], changes: [], status: "idle", runtime };
workspace.threads = []; workspace.activeThreadId = null;
let newThreads = 0;
workspace.projects = [{ id: thread.projectId, space: "productivity", name: "Cleo", path: "fixture", accent: "cyan" }];
const state = { phase: "idle", supported: true, prepared: true, currentVersion: "0.3.9", active: "old",
  baseline: "old", candidate: null, source: "fixture", threadId: null, error: null, logs: "", iteration: null,
  builds: [{ id: "old", kind: "local", sourceHash: "old", savedAt: "saved" }, { id: "new", kind: "local", sourceHash: "new" }],
  releases: [], pullRequest: null };
const store = new EvolutionStore(join(root, "evolution"), join(root, "data"));
store.read = async () => state;
store.build = async (id) => state.builds.find((b) => b.id === id);
const acceptance = new EvolutionAcceptance(store);
const requests = new EvolutionRequests(acceptance, async (_thread, prompt) => {
  if (holdAnalysis) await new Promise((resolve) => { releaseAnalysis = resolve; });
  if (modelFails) throw new Error("测试连接暂不可用；原需求已保留");
  if (missingEvidence) return { intent: "clarification", answer: "请提供 CI 日志和提交 SHA。" };
  if (prompt.includes("解释")) return { intent: "question", answer: "这个按钮打开侧栏，没有启动代码修改。", cases: [] };
  return { intent: "change", cases: [{ title: "侧栏显示文字", requirement: prompt,
    current: "尚未验证（静态分析）：当前显示图标", trigger: "打开侧栏", expectation: "看到按钮文字",
    evidence: "ui/src/Button.tsx:1: <button />" }] };
});
const snapshot = async () => ({ ...state, acceptance: await acceptance.status(state), acceptanceRequests: await requests.status() });
const publish = async () => page.evaluate((value) => window.testEvolutionListener?.(value), await snapshot());
async function waitForCompletedRequests(count) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const saved = await requests.status();
    if (saved.length === count && saved.at(-1).execution?.status === "completed") return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail("The original task did not complete its recorded request");
}
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
      if (action === "contributionBranches") return ["main", "self-evolving", ...(branchReady ? ["feature/requested"] : [])];
      if (action === "checkContribution") return { targetBranch: params.targetBranch, baseSha: "base", headSha: "head",
        compatible: true, snapshotFormat: "empty-target-snapshot-v1", checkedAt: new Date().toISOString() };
      if (action === "requestBranch") {
        assert.notEqual(params.targetBranch, "main");
        state.branchRequests = [{ id: params.submissionId, branch: params.targetBranch, body: params.body,
          buildId: params.buildId, buildName: "所选版本", sourceHash: "old", status: "requested",
          url: "https://github.com/StDoses72/Cleo-AI-agent/issues/123" }];
        return state.branchRequests[0];
      }
      if (action === "refreshBranchRequest") { state.branchRequests[0].status = "ready"; return state.branchRequests[0]; }
      if (action === "submit") {
        assert.notEqual(params.targetBranch, "main"); assert.equal(params.buildId, "old");
        submissions.push(params); return `https://github.com/StDoses72/Cleo-AI-agent/pull/${200 + submissions.length}`;
      }
      if (action === "abandonRequest") {
        const result = await store.exclusive(() => requests.abandon(params));
        state.threadId = null; state.error = null; return result;
      }
      if (action === "prepareRequest") {
        state.phase = "planning"; await publish();
        try { return await store.exclusive(() => requests.prepare(params)); }
        finally { state.phase = "idle"; }
      }
      if (action === "continueCaseRequest") return await store.exclusive(() => requests.continueCase(params));
      if (action === "cancelCase") return await store.exclusive(() => acceptance.cancel(params.id));
      if (action === "compareCases") {
        const report = await store.exclusive(() => acceptance.compare(state.candidate || state.active));
        state.error = null;
        return report;
      }
      if (action === "completeCase") return await store.exclusive(() => acceptance.complete(params.id));
      if (action === "reviseRequest") return await store.exclusive(() => requests.revise(params));
      if (action === "requestPrompt") return requests.editingPrompt(params.id);
      throw new Error("Unexpected evolution action: " + action);
    } finally { await publish(); }
  });
  await page.exposeFunction("testDesktopRequest", async (method, params, streamId) => {
    if (method === "load_workspace") return workspace;
    if (method === "load_memory") return structuredClone({ memories: workspace.memories, memoryOverview: workspace.memoryOverview });
    if (method === "get_runtime_catalog") return { nonProductivityProfiles: [], productivityProviders: [
      { id: "codex", label: "Codex", defaultModel: "test", models: ["test"], efforts: ["low"] }],
      defaultProductivityProvider: "codex", defaultNonProductivityProfile: "" };
    if (method === "get_productivity_models") return { provider: "codex", models: [], efforts: [] };
    if (method === "load_thread") return thread;
    if (method === "open_evolution_thread") {
      if (!params.thread_id) {
        thread = { ...thread, id: `new-thread-${++newThreads}` };
        workspace.threads.push(thread);
      } else thread = workspace.threads.find((t) => t.id === params.thread_id);
      return { thread, workspace };
    }
    if (method === "get_local_skills") return [];
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
  page.setDefaultTimeout(10000);
  modelFails = true;
  await page.getByTestId("composer-input").fill("给侧栏按钮显示文字");
  await page.getByTestId("composer-input").press("Enter");
  const retryPreparation = page.locator(".evolution-preparation").getByRole("button", { name: "重试", exact: true });
  await retryPreparation.waitFor();
  const original = (await requests.status())[0];
  assert.equal(newThreads, 1);
  modelFails = false;
  await retryPreparation.click();
  await waitForCompletedRequests(1);
  assert.equal(newThreads, 1);
  assert.equal((await requests.status()).length, 1);
  assert.equal((await requests.status())[0].threadId, original.threadId);
  assert.equal((await requests.status())[0].execution.status, "completed");
  assert.equal(await page.getByText("请求标识已用于另一条需求。", { exact: true }).count(), 0);

  // Retry an interrupted comparison of the unchanged active version without a candidate build.
  state.candidate = null; state.active = "old"; state.iteration = null;
  state.validation = { status: "unchanged", sourceHash: "old", message: "暂无程序改动" };
  state.error = "上次验收检查已中断";
  await publish();
  await page.locator(".evolution-cases > .evolution-case-list > summary").first().click();
  const item = (await requests.suite())[0];
  assert.equal(await page.getByRole("button", { name: "确认效果", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "取消此项", exact: true }).isEnabled(), true);
  await page.locator(".evolution-feedback > summary").click();
  assert.equal(await page.getByRole("button", { name: "继续修改：侧栏显示文字", exact: true }).isEnabled(), true);
  await page.locator(".evolution-error").getByRole("button", { name: "重试", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === "确认效果" && !b.disabled));

  // Continue with no new input: same case, same task, no model planning.
  await page.getByRole("button", { name: "继续修改：侧栏显示文字", exact: true }).click();
  await waitForCompletedRequests(2);
  await page.locator(".evolution-feedback-reply").filter({ hasText: "本轮实现已结束" }).waitFor();
  assert.equal((await requests.suite()).length, 1);
  assert.equal((await requests.status()).at(-1).cases[0].item.id, item.id);
  assert.equal((await requests.status()).at(-1).repair, true);
  assert.equal(newThreads, 1);
  assert.equal(actions.filter((a) => a === "prepareRequest").length, 2);
  await mkdir(output, { recursive: true });
  await page.getByRole("button", { name: "继续修改：侧栏显示文字", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "continue.png"), fullPage: true });

  state.candidate = null; state.draftDirty = true; state.iteration = null; state.validation = null;
  await publish();
  await page.getByRole("button", { name: "取消此项", exact: true }).click();
  await page.getByText(/0 项待验收/).waitFor();
  assert.equal((await acceptance.interactions.read()).completions.length, 0);
  assert.equal((await requests.suite())[0].expectation, item.expectation);
  await page.reload();
  await page.getByText(/0 项待验收/).waitFor();
  await page.getByText("历史记录 · 1 项", { exact: true }).click();
  await page.screenshot({ path: join(output, "cancelled.png"), fullPage: true });
  // A failed old request can be abandoned without any acceptance result or editing.
  requests.analyze = async () => { throw new Error("案例对应要求未引用原需求，请重试。"); };
  await page.getByTestId("composer-input").fill("已经不想继续的原需求");
  await page.getByTestId("composer-input").press("Enter");
  await page.getByRole("button", { name: "废弃原需求", exact: true }).waitFor();
  const abandoned = (await requests.status()).at(-1);
  await page.getByRole("button", { name: "废弃原需求", exact: true }).click();
  await page.getByRole("button", { name: "废弃原需求", exact: true }).waitFor({ state: "hidden" });
  assert.ok((await requests.status()).find((r) => r.id === abandoned.id).abandonedAt);
  assert.equal(state.threadId, null);
  await page.reload();
  await page.getByTestId("composer-input").waitFor();
  assert.doesNotMatch(await page.locator("body").innerText(), /操作未完成|案例对应要求未引用/);
  state.githubAuth = { status: "connected" }; state.draftDirty = false; await publish();
  await page.getByRole("button", { name: "新建 PR", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("option", { name: "self-evolving", exact: true }).waitFor({ state: "attached" });
  assert.equal(await dialog.getByRole("option", { name: "main", exact: true }).count(), 0);
  await dialog.getByLabel("PR 标题", { exact: true }).fill("提交选定版本");
  await dialog.getByLabel("PR 说明", { exact: true }).fill("已经检查");
  assert.equal(await dialog.getByRole("button", { name: "创建新 PR", exact: true }).isEnabled(), false);
  await dialog.getByLabel("目标分支", { exact: true }).selectOption("self-evolving");
  await dialog.getByRole("button", { name: "创建新 PR", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(submissions[0].targetBranch, "self-evolving");
  await page.getByRole("button", { name: "新建 PR", exact: true }).click();
  await dialog.getByRole("option", { name: "self-evolving", exact: true }).waitFor({ state: "attached" });
  await dialog.getByLabel("提交方式", { exact: true }).selectOption("request");
  await dialog.getByLabel("申请分支名称", { exact: true }).fill("main");
  await dialog.getByLabel("申请说明", { exact: true }).fill("需要单独的目标分支");
  assert.equal(await dialog.getByRole("button", { name: "提交分支申请", exact: true }).isEnabled(), false);
  await dialog.getByLabel("申请分支名称", { exact: true }).fill("feature/requested");
  await dialog.getByRole("button", { name: "提交分支申请", exact: true }).click();
  await dialog.getByText("申请已提交，目标分支尚待创建。", { exact: false }).waitFor();
  assert.equal(submissions.length, 1);
  assert.equal(await dialog.getByRole("button", { name: "向该分支提交 PR", exact: true }).count(), 0);
  assert.equal(await dialog.getByRole("button", { name: "检查分支是否已创建", exact: true }).count(), 0);
  branchReady = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await dialog.getByRole("button", { name: "向该分支提交 PR", exact: true }).click();
  await dialog.getByLabel("PR 标题", { exact: true }).fill("向新目标提交");
  await dialog.getByRole("button", { name: "创建新 PR", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(submissions[1].targetBranch, "feature/requested");
  assert.equal(submissions[1].buildId, state.branchRequests[0].buildId);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "passed", checks: "retry-stable-task, active-version-review, same-case-continuation, cancel-without-build, durable-cancellation, abandon-failed-request, explicit-target-PR, main-blocked, branch-application-then-PR", output }));
} catch (error) {
  console.error(JSON.stringify({ errors, body: await page.locator("body").innerText().catch(() => "unavailable"), actions }));
  throw error;
} finally {
  await application.close();
  if (server) await new Promise((done) => server.close(done));
  assert.equal(dirname(root), resolve(tmpdir()));
  await rm(root, { recursive: true, force: true });
}
