import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile = await mkdtemp(join(tmpdir(), "cleo-evolution-ui-"));
const output = join(ui, "output/playwright/evolution");
await mkdir(output, { recursive: true });
const application = await electron.launch({
  args: [".", `--user-data-dir=${profile}`], cwd: ui, env: { ...process.env, CLEO_DESKTOP_MOCK: "1" },
});
const page = await application.firstWindow();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.getByTestId("conversation").waitFor();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 850));
  await page.evaluate(() => {
    const previous = window.cleoDesktop;
    const state = {
      phase: "idle", supported: true, prepared: true, currentVersion: "0.3.9", active: "baseline",
      baseline: "baseline", baseTag: "v0.3.9", candidate: "candidate", source: "fixture", threadId: null,
      error: null, logs: "", builds: [
        { id: "baseline", kind: "official", version: "0.3.9", baseTag: "v0.3.9", baseline: true },
        { id: "candidate", kind: "local", version: null, baseTag: "v0.3.9", sourceHash: "fixture-source" },
      ], iteration: { base: "baseline" }, pullRequest: null,
      validation: { status: "passed", sourceHash: "fixture-source", candidate: "candidate", message: "检查通过，可以应用。" },
      releases: [], recoveryPath: "fixture",
    };
    window.evolutionActions = [];
    window.patchEvolution = (patch) => Object.assign(state, patch);
    window.cleoDesktop = {
      ...previous,
      getEvolutionState: async () => structuredClone(state),
      request: async (method, params) => {
        if (method !== "open_evolution_thread") throw new Error("Unexpected fixture request: " + method);
        const runtime = { provider: params.provider || "codex", model: params.model || "gpt-5.6-sol", effort: "low", access: "workspace-write", approval: "user", editable: true };
        const thread = { id: "evolution-chat-fixture", projectId: "productivity:cleo-evolution", space: "productivity", title: "Cleo 自我迭代", status: "idle", summary: "", updatedAt: "", items: [], changes: [], usage: { used: 0, limit: 128000, input: 0, output: 0 }, runtime };
        return { thread, workspace: { projects: [{ id: thread.projectId, space: "productivity", name: "Cleo", path: "fixture", accent: "cyan" }], threads: [thread], memories: [], memoryOverview: { summary: {}, dream_agent: {}, project_summaries: [], review_sources: [], entries: [] }, runtime } };
      },
      evolutionAction: async (action, params) => {
        window.evolutionActions.push({ action, params });
        if (action === "prepare") state.prepared = true;
        if (action === "thread") state.threadId = params.id;
        if (action === "prepareRequest" || action === "repairRequest") {
          state.testRequest = { ...params, status: "frozen", cases: [{ item: { id: "fixture-case", kind: "manual",
            expectation: "按钮清楚", evidence: "隔离 UI fixture", enabled: true } }] };
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
  });
  const labels = await page.locator(".rail-spaces button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
  assert.deepEqual(labels, ["对话", "开发", "进化", "记忆"]);
  await page.getByRole("button", { name: "进化", exact: true }).click();
  await page.getByTestId("composer-input").waitFor();
  assert.equal(await page.locator(".evolution-welcome,.thread-sidebar").count(), 0);
  assert.equal(await page.locator(".inspector").isVisible(), false);
  assert.equal(await page.getByRole("button", { name: "准备工作区", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "检查并构建", exact: true }).count(), 0);
  await page.getByRole("region", { name: "修改操作" }).waitFor();
  await page.getByRole("button", { name: "查看代码变更", exact: true }).click();
  assert.ok(await page.locator(".inspector").isVisible());
  await page.getByRole("button", { name: "查看代码变更", exact: true }).click();
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
  await page.getByRole("button", { name: "雾白" }).click();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: join(output, "03-evolution-light.png") });
  const fit = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, height: innerHeight, scrollHeight: document.documentElement.scrollHeight }));
  assert.equal(fit.width, fit.scrollWidth); assert.equal(fit.height, fit.scrollHeight);
  await page.evaluate(() => window.patchEvolution({ active: "baseline", candidate: null, iteration: null, prepared: false, threadId: null }));
  await page.getByRole("button", { name: "进化", exact: true }).click();
  await page.getByTestId("composer-input").fill("把我的 Cleo 按钮调整得更清楚");
  await page.getByTestId("composer-input").press("Enter");
  await page.waitForFunction(() => window.evolutionActions.some((item) => item.action === "requestPrompt"), { timeout: 20000 });
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
  assert.ok(await page.getByRole("button", { name: "应用", exact: true }).isDisabled());
  assert.ok(await page.getByRole("button", { name: "保存", exact: true }).isDisabled());
  assert.ok(!(await page.getByRole("alert").textContent()).includes("TS17001"), "Compiler logs belong in the disclosure, not the error banner.");
  assert.equal(await page.locator(".evolution-log").getAttribute("open"), null);
  await page.screenshot({ path: join(output, "04-evolution-validation-failed.png") });
  await page.getByTestId("composer-input").fill("保留我的下一条需求草稿");
  const preparedCount = automatic.filter((action) => action === "requestPrompt").length;
  await page.getByRole("button", { name: "让 Cleo 修复", exact: true }).click();
  await page.waitForFunction((before) => window.evolutionActions.filter((item) => item.action === "requestPrompt").length > before, preparedCount);
  await page.waitForFunction(() => document.querySelectorAll(".timeline h2").length >= 2);
  assert.equal(await page.getByTestId("composer-input").inputValue(), "保留我的下一条需求草稿");
  assert.ok(await page.getByRole("button", { name: "应用", exact: true }).isDisabled(), "Agent completion cannot replace desktop validation.");
  const repaired = await page.evaluate(() => window.evolutionActions.map((item) => item.action));
  assert.deepEqual(repaired.slice(repaired.lastIndexOf("repairPrompt")), ["repairPrompt", "repairRequest", "requestPrompt"]);
  await page.evaluate(() => window.patchEvolution({
    draftDirty: true, validation: { status: "failed", stage: "dependencies", repairable: false, message: "依赖准备未完成。" },
  }));
  await page.getByRole("button", { name: "进化", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "让 Cleo 修复", exact: true }).count(), 0);
  assert.ok(await page.getByRole("button", { name: "重新检查", exact: true }).isEnabled());
  await page.getByRole("button", { name: "重新检查", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "应用" && !button.disabled));
  await page.evaluate(() => window.patchEvolution({ active: "candidate", candidate: "candidate", draftDirty: true }));
  await page.getByRole("button", { name: "进化", exact: true }).click();
  assert.ok(await page.getByRole("button", { name: "保存", exact: true }).isDisabled());
  assert.ok(await page.getByRole("button", { name: "应用", exact: true }).isDisabled());
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "passed", labels, harnesses, fit, output }));
} finally {
  await application.close();
  assert.equal(dirname(resolve(profile)), resolve(tmpdir()));
  assert.ok(profile.includes("cleo-evolution-ui-"));
  await rm(profile, { recursive: true, force: true });
}
