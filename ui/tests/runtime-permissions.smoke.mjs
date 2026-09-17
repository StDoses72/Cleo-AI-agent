import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { snapshot } from "../src/services/mockData.ts";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "cleo-permissions-"));
const server = await createServer({ root: ui, cacheDir: join(scratch, "vite"), server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(fixture => {
    const control = window.permissionTest = { calls: [], running: false, fail: false, hold: false, release: null };
    const runtime = {
      provider: "codex", model: "test-model", effort: "high", access: "workspace-write", approval: "auto_review",
      settingsRevision: 0, pendingPermissions: null,
      permissionOptions: {
        access: [
          { value: "read-only", label: "只读", description: "默认只读，超出范围的操作由审批策略决定。" },
          { value: "workspace-write", label: "工作区可写", description: "默认允许写入工作目录，额外访问由审批策略决定。" },
          { value: "full-access", label: "完全访问", description: "允许写入工作区外的文件并联网；审批与外部服务授权仍单独处理。" },
        ],
        approval: [
          { value: "user", label: "人工审批", description: "由你处理需要确认的请求。" },
          { value: "auto_review", label: "自动审查", description: "由 Codex 审查需要批准的操作，可能允许或拒绝；必要的外部授权仍需确认。" },
          { value: "deny_all", label: "拒绝审批请求", description: "无需确认即可执行的操作继续运行，需要审批的请求会被拒绝。" },
        ],
      },
    };
    fixture.runtime = structuredClone(runtime);
    for (const thread of fixture.threads) thread.runtime = structuredClone(runtime);
    control.fixture = fixture;
    window.cleoDesktop = {
      request: async (method, params = {}) => {
        if (method === "load_workspace") return structuredClone(fixture);
        if (method === "load_memory") return { memories: fixture.memories, memoryOverview: fixture.memoryOverview };
        if (method === "load_thread") return structuredClone(fixture.threads.find(thread => thread.id === params.thread_id));
        if (method === "get_pending_questions" || method === "get_local_skills") return [];
        if (method === "get_runtime_catalog") return { nonProductivityProfiles: [], defaultNonProductivityProfile: "", defaultProductivityProvider: "codex", productivityProviders: [] };
        if (method === "get_productivity_models") return { provider: "codex", source: "sdk", models: [] };
        if (method === "get_model_settings") return { profiles: [], connections: [], activeAgent: "", activeDreamAgent: "" };
        if (method === "get_agent_instructions") return { content: "", path: "AGENTS.md", exists: false };
        if (method === "update_runtime") {
          control.calls.push(params);
          if (control.fail) throw new Error("权限未保存：服务暂时不可用");
          const thread = fixture.threads.find(thread => thread.id === params.thread_id);
          const current = thread.runtime;
          const { discardPendingPermissions, ...changes } = params.update;
          thread.runtime = { ...current, settingsRevision: current.settingsRevision + 1 };
          if (discardPendingPermissions) thread.runtime.pendingPermissions = null;
          else if (control.running) thread.runtime.pendingPermissions = { provider: current.provider, ...current.pendingPermissions, ...changes };
          else Object.assign(thread.runtime, changes, { pendingPermissions: null });
          const response = structuredClone(thread.runtime);
          if (control.hold) await new Promise(resolve => { control.release = resolve; });
          return response;
        }
        throw new Error(`Unhandled fixture method: ${method}`);
      },
      getEvolutionState: async () => ({ phase: "idle", supported: false, builds: [], releases: [] }),
      onEvolutionState: () => () => {}, confirmHealthy: async () => {}, onStreamEvent: () => () => {},
      getUpdateState: async () => ({ phase: "unsupported", currentVersion: "0.4.8" }),
      onUpdateState: () => () => {},
    };
  }, snapshot);
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByTestId("composer-input").waitFor();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  const open = async () => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settings.getByRole("button", { name: "运行设置", exact: true }).click();
  };
  const access = settings.getByLabel("文件访问", { exact: true });
  const approval = settings.getByLabel("审批方式", { exact: true });
  const settled = () => access.and(page.locator(":enabled")).waitFor();
  await open();
  assert.equal(await approval.inputValue(), "auto_review");
  await access.selectOption("full-access"); await settled();
  assert.equal(await approval.inputValue(), "auto_review", "Access must not change approval policy");
  await page.evaluate(() => { window.permissionTest.fail = true; });
  await approval.selectOption("deny_all");
  await settings.getByRole("alert").getByText("权限未保存：服务暂时不可用").waitFor();
  assert.equal(await approval.inputValue(), "auto_review");
  assert.equal(await access.inputValue(), "full-access");
  await page.evaluate(() => { window.permissionTest.fail = false; });
  await approval.selectOption("deny_all"); await settled();
  assert.equal(await approval.inputValue(), "deny_all");
  assert.equal(await settings.getByRole("alert").count(), 0);

  await page.evaluate(() => { window.permissionTest.running = true; });
  await access.selectOption("read-only"); await settled();
  await approval.selectOption("user"); await settled();
  await settings.getByText("下次运行使用所选权限。当前（含补充指令）：完全访问 · 拒绝审批请求。").waitFor();
  assert.deepEqual(await page.evaluate(() => {
    const runtime = window.permissionTest.fixture.threads.find(t => t.id === "desktop-ui").runtime;
    return [runtime.access, runtime.approval, runtime.pendingPermissions];
  }), ["full-access", "deny_all", { provider: "codex", access: "read-only", approval: "user" }]);
  if (process.env.CLEO_SMOKE_OUTPUT) await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "permissions-dark.png") });
  await settings.getByRole("button", { name: "取消更改", exact: true }).click(); await settled();
  assert.equal(await access.inputValue(), "full-access");
  assert.equal(await approval.inputValue(), "deny_all");

  // A slow response from a previous settings page must not replace newer settings.
  await page.evaluate(() => { window.permissionTest.running = false; window.permissionTest.hold = true; });
  await access.selectOption("workspace-write");
  await page.waitForFunction(() => Boolean(window.permissionTest.release));
  await settings.getByRole("button", { name: "外观", exact: true }).click();
  await settings.getByRole("button", { name: "运行设置", exact: true }).click();
  await page.evaluate(() => { window.permissionTest.hold = false; });
  await access.selectOption("read-only"); await settled();
  await page.evaluate(() => window.permissionTest.release());
  await page.waitForTimeout(100);
  assert.equal(await access.inputValue(), "read-only", "Late permission response replaced newer settings");

  await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.getByRole("button", { name: /^统一 managed 与 native sessions/ }).click();
  await open();
  assert.equal(await access.inputValue(), "workspace-write", "Permissions leaked into another task");
  assert.equal(await approval.inputValue(), "auto_review");
  await settings.getByRole("button", { name: "外观", exact: true }).click();
  await settings.getByRole("button", { name: "浅色", exact: true }).click();
  await settings.getByRole("button", { name: "运行设置", exact: true }).click();
  await page.setViewportSize({ width: 760, height: 900 });
  if (process.env.CLEO_SMOKE_OUTPUT) await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "permissions-light-narrow.png") });
  assert.equal(await settings.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.evaluate(() => {
    const runtime = window.permissionTest.fixture.threads.find(t => t.id === "desktop-ui").runtime;
    runtime.permissionOptions = { access: [], approval: [], reason: "此任务使用运行后端的权限配置。" };
    runtime.settingsRevision++;
  });
  await page.getByRole("button", { name: /^完成独立桌面 UI/ }).click();
  await open();
  await settings.getByText("此任务使用运行后端的权限配置。").waitFor();
  assert.equal(await access.count(), 0, "Unsupported permission controls must not be offered");
  assert.equal(await approval.count(), 0);
  await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
  for (const [provider, initial, selected, choices] of [
    ["claude", "default", "auto", [["default", "人工审批"], ["auto", "自动审查"], ["acceptEdits", "自动允许编辑"]]],
    ["native-acp", "deny_all", "auto_allow", [["user", "人工审批"], ["auto_allow", "自动允许请求"], ["deny_all", "自动拒绝请求"]]],
  ]) {
    await page.evaluate(({ provider, initial, choices }) => {
      const runtime = window.permissionTest.fixture.threads.find(t => t.id === "desktop-ui").runtime;
      Object.assign(runtime, { provider, access: "default", approval: initial, permissionOptions: {
        access: [], approval: choices.map(([value, label]) => ({ value, label, description: "" })),
        reason: "此服务不提供独立的文件访问范围设置。",
      }, settingsRevision: runtime.settingsRevision + 1 });
    }, { provider, initial, choices });
    await page.getByRole("button", { name: /^统一 managed 与 native sessions/ }).click();
    await page.getByRole("button", { name: /^完成独立桌面 UI/ }).click();
    await open();
    await approval.waitFor();
    assert.equal(await access.count(), 0, "Native approval modes are not Codex file access modes");
    await approval.selectOption(selected);
    await approval.and(page.locator(":enabled")).waitFor();
    assert.equal(await approval.inputValue(), selected);
    await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    const thread = window.permissionTest.fixture.threads.find(t => t.id === "desktop-ui");
    thread.items = [
      { id: "u", type: "message", role: "user", content: "Audit history", time: "" },
      { id: "approved", type: "tool", name: "自动审查 · 已允许", command: "test command A", status: "done", approvalAudit: true, output: "来源：codex · 自动审查\n结果：已允许" },
      { id: "denied", type: "tool", name: "自动审查 · 已拒绝", command: "test command B", status: "error", approvalAudit: true, output: "来源：codex · 自动审查\n结果：已拒绝\n原因：native review reason" },
      { id: "claude-tool", type: "tool", name: "Read", command: "test file", status: "done", output: "file content", permission: { source: "Claude 后端", policy: "auto", decision: "accept" } },
      { id: "a", type: "message", role: "assistant", content: "Audit complete", time: "" },
    ];
  });
  await page.getByRole("button", { name: /^统一 managed 与 native sessions/ }).click();
  await page.getByRole("button", { name: /^完成独立桌面 UI/ }).click();
  await page.getByText("Audit complete", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("approval-prompt").count(), 0, "Automatic audit history must not require a manual decision");
  await page.getByTestId("tool-group").getByRole("button").click();
  const denied = page.getByTestId("tool-process").filter({ hasText: "自动审查 · 已拒绝" });
  await denied.locator("summary").click();
  await denied.getByText(/native review reason/).waitFor();
  assert.equal(await denied.getByText("失败", { exact: true }).count(), 0);
  const nativeTool = page.getByTestId("tool-process").filter({ hasText: "Read" });
  await nativeTool.locator("summary").click();
  await nativeTool.getByText("Claude 后端 · 自动审查 · 已允许执行", { exact: true }).waitFor();
  if (process.env.CLEO_SMOKE_OUTPUT) await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "approval-history.png") });
  assert.deepEqual(errors, []);
  console.log("PASS: independent permissions, automatic review, saved/pending state, failure recovery, discard, stale responses, task isolation, native Claude/ACP modes, durable audit display, dark/light and narrow layout");
} finally {
  await browser?.close(); await server.close();
  assert.equal(dirname(scratch), resolve(tmpdir()));
  await rm(scratch, { recursive: true, force: true });
}
