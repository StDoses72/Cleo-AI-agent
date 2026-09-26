import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { snapshot } from "../src/services/mockData.ts";

const ui = process.env.CLEO_SMOKE_APP_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile = await mkdtemp(join(tmpdir(), "cleo-evolution-ui-"));
const output = process.env.CLEO_SMOKE_OUTPUT ?? join(profile, "screenshots");
await mkdir(output, { recursive: true });
const application = await electron.launch({
  args: [".", `--user-data-dir=${profile}`], cwd: ui, env: { ...process.env, CLEO_DESKTOP_MOCK: "1", CLEO_HOME: join(profile, "home") },
});
const page = await application.firstWindow();
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.getByTestId("conversation").waitFor();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 850));
  await page.addInitScript(({ fixture }) => {
    const workspace = structuredClone(fixture);
    const streams = new Set();
    const evolutionListeners = new Set();
    const publish = () => { for (const listener of evolutionListeners) listener(structuredClone(state)); };
    const timeline = thread => ({ items: thread.items, before: "0", after: String(thread.items.length - 1),
      total: thread.items.length, hasBefore: false, hasAfter: false, revision: String(thread.items.length) });
    const state = {
      phase: "idle", supported: true, prepared: true, currentVersion: "0.3.9", active: "baseline",
      baseline: "baseline", baseTag: "v0.3.9", candidate: "candidate", source: "fixture", threadId: null,
      error: null, logs: "", builds: [
        { id: "baseline", kind: "official", version: "0.3.9", baseTag: "v0.3.9", baseline: true },
        { id: "candidate", kind: "local", version: null, baseTag: "v0.3.9", sourceHash: "fixture-source" },
      ], iteration: { base: "baseline" }, pullRequest: null,
      validation: { status: "passed", sourceHash: "fixture-source", candidate: "candidate", message: "检查通过，可以应用。" },
      releases: [], releaseTypes: { "v0.3.9": false }, recoveryPath: "fixture",
    };
    window.evolutionActions = [];
    window.failEvolutionRead = true;
    window.patchEvolution = (patch) => Object.assign(state, patch);
    window.cleoDesktop = {
      getEvolutionState: async () => {
        if (window.failEvolutionRead) throw new Error("进化状态暂时不可用（测试）");
        return structuredClone(state);
      },
      onEvolutionState: listener => { evolutionListeners.add(listener); return () => evolutionListeners.delete(listener); },
      onStreamEvent: listener => { streams.add(listener); return () => streams.delete(listener); },
      confirmHealthy: async () => {},
      getUpdateState: async () => ({ phase: "unsupported", currentVersion: "fixture", latestVersion: null, error: null, downloadedBytes: 0, totalBytes: 0 }),
      onUpdateState: () => () => {},
      request: async (method, params = {}, streamId) => {
        if (method === "load_workspace") return structuredClone(workspace);
        if (method === "load_memory") return { memories: workspace.memories, memoryOverview: workspace.memoryOverview };
        if (method === "get_model_settings") return { profiles: [], connections: [], activeAgent: "", activeDreamAgent: "" };
        if (method === "get_agent_instructions") return { path: "AGENTS.md", content: "", exists: false };
        if (method === "get_pending_questions") return [];
        if (method === "get_runtime_catalog") return { defaultProductivityProvider: "codex", defaultNonProductivityProfile: "", nonProductivityProfiles: [],
          productivityProviders: ["codex", "claude"].map(id => ({ id, type: `${id}_sdk`, defaultModel: "test", label: id })) };
        if (method === "get_productivity_models") return { provider: params.provider, source: "sdk", models: [{ id: "test", label: "test", supportedEfforts: ["low"], defaultEffort: "low", isDefault: true }] };
        if (method === "load_thread") return structuredClone(workspace.threads.find(thread => thread.id === params.thread_id));
        if (method === "load_timeline") return timeline(workspace.threads.find(thread => thread.id === params.thread_id));
        if (method === "stream_turn") {
          const thread = workspace.threads.find(thread => thread.id === params.thread_id);
          const turnId = crypto.randomUUID();
          const emit = event => { for (const listener of streams) listener({ streamId, event }); };
          const user = { id: turnId, turnId, type: "message", role: "user", content: params.prompt, time: "", order: thread.items.length, cursor: String(thread.items.length) };
          thread.items.push(user); thread.status = "running";
          emit({ type: "turn-started", item: user });
          await new Promise(resolve => setTimeout(resolve, 30));
          const reply = { id: `${turnId}-answer`, turnId, type: "message", role: "assistant", content: "## 运行完成\n\n隔离测试回复。", time: "", order: thread.items.length, cursor: String(thread.items.length) };
          thread.items.push(reply); thread.status = "completed";
          emit({ type: "upsert-item", item: reply }); emit({ type: "done", summary: "隔离测试完成" });
          state.testRequest.execution = { status: "completed" }; publish();
          return null;
        }
        if (method !== "open_evolution_thread") throw new Error("Unexpected fixture request: " + method);
        const runtime = { provider: params.provider || "codex", model: params.model || "gpt-5.6-sol", effort: "low", access: "workspace-write", approval: "user", editable: true };
        let thread = workspace.threads.find(thread => thread.id === "evolution-chat-fixture");
        if (!thread) {
          thread = { id: "evolution-chat-fixture", projectId: "productivity:cleo-evolution", space: "productivity", title: "Cleo 自我迭代", status: "idle", summary: "", updatedAt: "", items: [], changes: [], runtime,
            history: { before: null, after: null, total: 0, hasBefore: false, hasAfter: false, revision: "0" } };
          workspace.threads.push(thread);
          workspace.projects.push({ id: thread.projectId, space: "productivity", name: "Cleo", path: "fixture", accent: "cyan" });
        }
        return structuredClone({ thread, workspace });
      },
      evolutionAction: async (action, params) => {
        window.evolutionActions.push({ action, params });
        if (action === "releases") return [];
        if (action === "prepare") state.prepared = true;
        if (action === "thread") state.threadId = params.id;
        if (action === "prepareRequest" || action === "repairRequest") {
          state.testRequest = { ...params, status: "frozen", cases: [{ item: { id: "fixture-case", kind: "manual",
            expectation: "按钮清楚", evidence: "隔离 UI fixture", enabled: true } }] };
          state.acceptanceRequests = [...(state.acceptanceRequests || []), state.testRequest];
          return state.testRequest;
        }
        if (action === "requestPrompt") return `[[CLEO_ACCEPTANCE_REQUEST:${params.id}]]\n${state.testRequest.prompt}`;
        if (action === "begin") {
          state.iteration = { base: state.active }; state.draftDirty = true;
          state.validation = { status: "pending", message: "待检查" };
        }
        if (action === "build") {
          state.candidate = "candidate"; state.draftDirty = false;
          state.validation = { status: "passed", sourceHash: "fixture-source", candidate: "candidate", message: "检查通过，可以应用。" };
        }
        if (action === "repairPrompt") return "修复桌面检查错误：TS17001，重复 JSX 属性。";
        if (action === "apply") state.active = params.id;
        if (action === "save") {
          const build = state.builds.find((item) => item.id === state.active);
          build.savedAt = "today"; build.name = params.name;
          state.iteration = null; state.candidate = null;
        }
        if (action === "select") state.active = params.id;
      },
    };
  }, { fixture: snapshot });
  await page.reload();
  await page.getByTestId("conversation").waitFor();
  const labels = await page.locator(".rail-spaces button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
  assert.deepEqual(labels, ["对话", "开发", "进化", "记忆"]);
  await page.getByRole("button", { name: "进化", exact: true }).click();
  const loadError = page.getByRole("alert").filter({ hasText: "进化状态暂时不可用（测试）" });
  await loadError.waitFor();
  await page.evaluate(() => { window.failEvolutionRead = false; });
  await loadError.getByRole("button", { name: "重试", exact: true }).click();
  await loadError.waitFor({ state: "hidden" });
  await page.getByTestId("composer-input").waitFor();
  assert.equal(await page.locator(".evolution-welcome,.thread-sidebar").count(), 0);
  assert.equal(await page.locator(".inspector").isVisible(), false);
  assert.equal(await page.getByRole("button", { name: "准备工作区", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "检查并构建", exact: true }).count(), 0);
  await page.getByRole("region", { name: "修改操作" }).waitFor();
  await page.getByRole("button", { name: "查看代码变更", exact: true }).click();
  assert.ok(await page.locator(".inspector").isVisible());
  await page.getByRole("button", { name: "查看代码变更", exact: true }).click();
  await page.getByRole("button", { name: "添加验收目标", exact: true }).click();
  await page.getByRole("dialog", { name: "改进 Cleo", exact: true }).waitFor();
  assert(await page.getByLabel("案例名称", { exact: true }).evaluate(input => input === document.activeElement));
  await page.getByRole("button", { name: "关闭案例", exact: true }).click();
  await page.getByTestId("runtime-selector").click();
  await page.getByTestId("runtime-menu").waitFor();
  const harnesses = await page.locator(".runtime-menu strong").allTextContents();
  assert.ok(harnesses.length >= 2, "Evolution must show the ordinary multi-harness picker.");
  await page.keyboard.press("Escape");
  await page.getByTestId("runtime-selector").click().catch(() => {});
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "保存" && !button.disabled));
  await page.screenshot({ path: join(output, "01-evolution-dark.png") });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByLabel("本地版本名称").fill("更好的侧栏");
  await page.getByRole("button", { name: "确认保存", exact: true }).click();
  await page.waitForFunction(() => window.evolutionActions.some((item) => item.action === "save"));
  await page.getByRole("button", { name: "选择版本", exact: true }).click();
  await page.getByRole("button", { name: /正式版 v0.3.9.*使用此版本/ }).click();
  await page.waitForFunction(() => window.evolutionActions.some((item) => item.action === "select"));
  const actions = await page.evaluate(() => window.evolutionActions);
  assert.deepEqual(actions.filter((item) => ["apply", "save", "select"].includes(item.action)), [
    { action: "apply", params: { id: "candidate" } },
    { action: "save", params: { name: "更好的侧栏" } },
    { action: "select", params: { id: "baseline" } },
  ]);
  await page.screenshot({ path: join(output, "02-evolution-ready.png") });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "浅色" }).click();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: join(output, "03-evolution-light.png") });
  const fit = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, height: innerHeight, scrollHeight: document.documentElement.scrollHeight }));
  assert.equal(fit.width, fit.scrollWidth); assert.equal(fit.height, fit.scrollHeight);
  await page.evaluate(() => window.patchEvolution({ active: "baseline", candidate: null, iteration: null, prepared: false, threadId: null }));
  await page.getByRole("button", { name: "进化", exact: true }).click();
  await page.getByTestId("composer-input").fill("把我的 Cleo 按钮调整得更清楚");
  await page.getByTestId("composer-input").press("Enter");
  await page.waitForFunction(() => window.evolutionActions.some((item) => item.action === "requestPrompt"));
  await page.getByRole("heading", { name: "运行完成", exact: true }).waitFor();
  const automatic = await page.evaluate(() => window.evolutionActions.map((item) => item.action));
  assert.ok(automatic.indexOf("prepare") < automatic.indexOf("thread"));
  assert.ok(automatic.indexOf("thread") < automatic.indexOf("prepareRequest"));
  assert.ok(automatic.indexOf("prepareRequest") < automatic.indexOf("requestPrompt"));
  assert.ok(!automatic.includes("begin") && !automatic.includes("build"), "Renderer must leave editing/build authorization to the desktop, exercised by smoke-evolution-preparation.");
  await page.evaluate(() => window.patchEvolution({
    active: "baseline", candidate: "candidate", draftDirty: false, logs: "",
    validation: { status: "failed", stage: "typecheck", sourceHash: "fixture-source", repairable: true,
      message: "前端类型检查未通过。当前修改尚不可应用。请让 Cleo 修复后重新检查。",
      details: "src/components/Conversation.tsx(228,9): error TS17001: JSX elements cannot have multiple attributes with the same name." },
  }));
  await page.getByRole("button", { name: "进化", exact: true }).click();
  await page.getByRole("button", { name: "让 Cleo 修复", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "应用", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "保存", exact: true }).count(), 0);
  assert.ok(!(await page.getByRole("alert").textContent()).includes("TS17001"), "Compiler logs belong in the disclosure, not the error banner.");
  assert.equal(await page.locator(".evolution-log").getAttribute("open"), null);
  await page.screenshot({ path: join(output, "04-evolution-validation-failed.png") });
  await page.getByTestId("composer-input").fill("保留我的下一条需求草稿");
  const preparedCount = automatic.filter((action) => action === "requestPrompt").length;
  await page.getByRole("button", { name: "让 Cleo 修复", exact: true }).click();
  await page.waitForFunction((before) => window.evolutionActions.filter((item) => item.action === "requestPrompt").length > before, preparedCount);
  await page.waitForFunction(() => document.querySelectorAll(".timeline h2").length >= 2);
  assert.equal(await page.getByTestId("composer-input").inputValue(), "保留我的下一条需求草稿");
  assert.equal(await page.getByRole("button", { name: "应用", exact: true }).count(), 0, "Agent completion cannot replace desktop validation.");
  const repaired = await page.evaluate(() => window.evolutionActions.map((item) => item.action));
  assert.deepEqual(repaired.slice(repaired.lastIndexOf("repairPrompt")), ["repairPrompt", "repairRequest", "requestPrompt"]);
  await page.evaluate(() => window.patchEvolution({
    draftDirty: true, validation: { status: "failed", stage: "dependencies", repairable: false, message: "依赖准备未完成。" },
  }));
  await page.getByRole("button", { name: "进化", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "让 Cleo 修复", exact: true }).count(), 0);
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "重新检查" && !button.disabled));
  assert.ok(await page.getByRole("button", { name: "重新检查", exact: true }).isEnabled());
  await page.getByRole("button", { name: "重新检查", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "应用" && !button.disabled));
  await page.evaluate(() => window.patchEvolution({ active: "candidate", candidate: "candidate", draftDirty: true }));
  await page.getByRole("button", { name: "进化", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "保存", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "应用", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.patchEvolution({ supported: false }));
  await page.getByRole("button", { name: "进化", exact: true }).click();
  await page.getByText("当前运行方式不支持本地进化。", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("send-button").isDisabled(), true);
  console.log(JSON.stringify({ status: "passed", labels, harnesses, fit, output }));
} catch (error) {
  console.error(await page.evaluate(async () => ({ state: await window.cleoDesktop.getEvolutionState(), actions: window.evolutionActions, body: document.body.innerText })));
  throw error;
} finally {
  await application.close();
  assert.equal(dirname(resolve(profile)), resolve(tmpdir()));
  assert.ok(profile.includes("cleo-evolution-ui-"));
  await rm(profile, { recursive: true, force: true });
}

// Keep cross-view navigation and in-flight output isolation in the existing desktop smoke gate.
await import("./smoke-evolution-isolation.mjs");
