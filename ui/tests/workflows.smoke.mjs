import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

// The workflows page against the offline mock client: library, editor, confirmation, a run that
// loops, one that fails and is retried, one that fans out and is stopped, and a drafted workflow.
const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(ui, "output/workflows");
const scratch = await mkdtemp(join(tmpdir(), "cleo-workflows-ui-"));
const server = await createServer({ root: ui, cacheDir: join(scratch, "vite"), logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("dialog", (dialog) => void dialog.accept());
  const runStatus = () => page.getByTestId("workflow-run-status").getAttribute("data-status");
  const settled = async (expected) => {
    await page.waitForFunction(() => {
      const status = document.querySelector('[data-testid="workflow-run-status"]');
      return status && status.dataset.status !== "running";
    }, null, { timeout: 40_000 });
    assert.equal(await runStatus(), expected);
  };
  const toLibrary = async () => {
    await page.locator(".wf-back").click();
    await page.getByTestId("workflow-tab-workflows").click();
    await page.getByTestId("workflow-list").waitFor();
  };
  const start = async (card, task) => {
    await page.getByTestId("workflow-card-run").nth(card).click();
    await page.getByTestId("workflow-launch").waitFor();
    await page.getByTestId("workflow-task").fill(task);
    await page.getByTestId("workflow-start").click();
    await page.getByTestId("workflow-run-view").waitFor();
  };

  await page.goto(server.resolvedUrls.local[0]);
  await page.getByTestId("conversation").waitFor({ timeout: 15_000 });
  await page.getByTestId("open-workflows").click();
  await page.getByTestId("workflow-list").waitFor();
  assert.equal(await page.getByTestId("workflow-card").count(), 3);
  assert.equal(await page.locator(".inspector").count(), 0, "The workflows page takes the details column too");

  // Editing: the loop's round limit is validated, and an invalid workflow cannot be started.
  await page.getByTestId("workflow-card").first().locator(".wf-card-main").click();
  await page.getByTestId("workflow-editor").waitFor();
  assert.equal(await page.getByTestId("workflow-save").isDisabled(), true, "Nothing to save before an edit");
  const rounds = page.getByLabel("最多几轮", { exact: true });
  await rounds.fill("9");
  await page.getByTestId("workflow-checks").getByText("轮数要在 1 到 5 之间", { exact: false }).waitFor();
  assert.equal(await page.getByTestId("workflow-run").isDisabled(), true);
  await rounds.fill("3");
  await page.getByTestId("workflow-checks").getByText("可以运行", { exact: false }).waitFor();
  assert.equal(await page.getByTestId("workflow-save").isDisabled(), true, "Back at the saved values");

  // Confirmation: no agent starts without a task.
  await page.getByTestId("workflow-run").click();
  await page.getByTestId("workflow-launch").waitFor();
  await page.getByTestId("workflow-start").click();
  await page.getByText("先写下这次要完成的任务", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("workflow-run-view").count(), 0);
  await page.getByTestId("workflow-task").fill("给会话导出接口加上分页，并保持旧客户端可用");
  await page.screenshot({ path: join(output, "launch.png") });
  await page.getByTestId("workflow-start").click();
  await page.getByTestId("workflow-run-view").waitFor();

  // The loop takes a second round because the judge sent the first plan back.
  await settled("completed");
  const verdicts = await page.locator(".wf-run-node-title em.verdict").allTextContents();
  assert.deepEqual(verdicts, ["需要修改", "通过"]);
  assert.equal(await page.getByTestId("workflow-run-node").count(), 6);
  await page.getByTestId("workflow-result").getByText("验收结论：通过", { exact: false }).waitFor();
  await page.screenshot({ path: join(output, "run-completed.png") });

  // One reviewer fails: the branch still running is cancelled, and a retry reruns the phase.
  await toLibrary();
  await start(1, "评审分页接口的改动");
  await settled("failed");
  await page.getByTestId("workflow-failure").getByText("用量窗口已满", { exact: false }).waitFor();
  const statuses = await page.getByTestId("workflow-run-node").evaluateAll((nodes) => nodes.map((node) => node.dataset.status));
  assert.deepEqual([...statuses].sort(), ["cancelled", "done", "failed"]);
  await page.screenshot({ path: join(output, "run-failed.png") });
  await page.getByTestId("workflow-retry").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="workflow-run-status"]')?.dataset.status === "running");
  await settled("completed");
  assert.equal(await page.getByTestId("workflow-failure").count(), 0);

  // One agent per item of the reviewer's list; stopping cancels them and the task is kept for a rerun.
  await toLibrary();
  await start(2, "修复登录流程里发现的问题");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="workflow-run-node"]').length === 4, null, { timeout: 20_000 });
  await page.getByTestId("workflow-stop").click();
  await settled("cancelled");
  await page.getByTestId("workflow-run-again").click();
  await page.getByTestId("workflow-launch").waitFor();
  assert.equal(await page.getByTestId("workflow-task").inputValue(), "修复登录流程里发现的问题");

  // A workflow Cleo drafts is not saved and does not run until the user confirms it.
  await toLibrary();
  await page.getByTestId("workflow-draft-input").fill("修复设置页在窄屏下的布局缺陷");
  await page.getByTestId("workflow-draft-submit").click();
  await page.getByTestId("workflow-editor").waitFor();
  await page.getByText("尚未保存", { exact: true }).waitFor();
  await page.screenshot({ path: join(output, "draft-editor.png") });
  await page.getByTestId("workflow-run").click();
  await page.getByText("你确认后才会启动 agent", { exact: false }).waitFor();
  assert.equal(await page.getByTestId("workflow-task").inputValue(), "修复设置页在窄屏下的布局缺陷");
  await page.getByTestId("workflow-start").click();
  await page.getByTestId("workflow-run-view").waitFor();
  await settled("completed");
  await page.getByTestId("workflow-save-run").click();
  await page.getByTestId("workflow-save-run").waitFor({ state: "detached" });
  await toLibrary();
  assert.equal(await page.getByTestId("workflow-card").count(), 4);

  // A new workflow lists what is missing; leaving the page and returning keeps the unsaved edit.
  await page.getByTestId("new-workflow").click();
  await page.getByTestId("workflow-editor").waitFor();
  await page.getByTestId("add-loop-step").click();
  await page.getByTestId("workflow-checks").getByText("工作流需要一个名称", { exact: true }).waitFor();
  await page.getByLabel("工作流名称", { exact: true }).fill("临时流程");
  await page.getByRole("button", { name: "记忆", exact: true }).click();
  await page.getByTestId("memory-view").waitFor();
  await page.getByTestId("open-workflows").click();
  assert.equal(await page.getByLabel("工作流名称", { exact: true }).inputValue(), "临时流程");
  await page.locator(".wf-back").click();
  await page.getByTestId("workflow-tab-runs").click();
  assert.equal(await page.getByTestId("workflow-run-row").count(), 5);
  await page.screenshot({ path: join(output, "runs.png") });

  // Opening a conversation leaves the page; the minimum window width keeps the editor usable.
  await page.getByTestId("thread-list").getByRole("button", { name: /修正 Codex 用量显示/ }).first().click();
  await page.getByTestId("conversation").waitFor();
  assert.equal(await page.getByTestId("workflow-view").count(), 0);
  await page.getByTestId("open-workflows").click();
  await page.getByTestId("workflow-tab-workflows").click();
  await page.setViewportSize({ width: 980, height: 680 });
  await page.getByTestId("workflow-card").nth(1).locator(".wf-card-main").click();
  await page.getByTestId("workflow-editor").waitFor();
  const fit = await page.evaluate(() => {
    const view = document.querySelector('[data-testid="workflow-view"]');
    const run = document.querySelector('[data-testid="workflow-run"]').getBoundingClientRect();
    return { overflow: view.scrollWidth - view.clientWidth, runRight: run.right, viewRight: view.getBoundingClientRect().right };
  });
  assert.equal(fit.overflow, 0, "No horizontal scrolling at the minimum window width");
  assert.ok(fit.runRight <= fit.viewRight, "The run button stays inside the pane");
  await page.screenshot({ path: join(output, "editor-minimum-window.png") });

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "passed", runs: 5, failedThenRetried: true, stopped: true, drafted: true, paidModelTurns: 0 }));
} finally {
  await browser?.close();
  await server.close();
  await rm(scratch, { recursive: true, force: true });
}
