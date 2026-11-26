import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

// The workflows page against the offline mock client. A workflow is built by hand on the canvas
// (right-click, drag from a node, drag from the palette), then run; the saved ones cover a loop,
// a failure that is retried, a fan-out that is stopped, and a workflow Cleo drafts.
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

  const nodes = () => page.getByTestId("workflow-node");
  const edges = () => page.getByTestId("workflow-edge");
  const node = (role) => page.locator('[data-testid="workflow-node"]', { hasText: role });
  const port = (role) => node(role).locator('[data-port="out"]');
  const end = (id) => page.locator(`[data-node-id="${id}"]`);
  const centre = async (locator) => {
    const box = await locator.boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
  };
  const counts = async () => [await nodes().count(), await edges().count()];
  const settled = async (expected) => {
    await page.waitForFunction(() => {
      const status = document.querySelector('[data-testid="workflow-run-status"]');
      return status && status.dataset.status !== "running";
    }, null, { timeout: 40_000 });
    assert.equal(await page.getByTestId("workflow-run-status").getAttribute("data-status"), expected);
  };
  const toLibrary = async () => {
    await page.locator(".wf-back").click();
    await page.getByTestId("workflow-tab-workflows").click();
    await page.getByTestId("workflow-list").waitFor();
  };
  const start = async (name, task) => {
    await page.locator('[data-testid="workflow-card"]', { hasText: name }).getByTestId("workflow-card-run").click();
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

  // A saved workflow opens as a graph; its loop is an edge with a round limit.
  await page.getByTestId("workflow-card").first().locator(".wf-card-main").click();
  await page.getByTestId("workflow-editor").waitFor();
  assert.deepEqual(await counts(), [4, 6]);
  assert.equal(await page.getByTestId("workflow-save").isDisabled(), true, "Nothing to save before an edit");
  await page.locator(".wf-loop-label").click();
  const rounds = page.getByTestId("loop-rounds");
  await rounds.fill("9");
  await page.getByTestId("workflow-checks").getByText("轮数要在 1 到 5 之间", { exact: false }).waitFor();
  assert.equal(await page.getByTestId("workflow-run").isDisabled(), true);
  await rounds.fill("3");
  await page.getByTestId("workflow-checks").getByText("可以运行", { exact: false }).waitFor();
  await page.screenshot({ path: join(output, "editor.png") });
  await page.locator(".wf-back").click();

  // Building by hand. Right-click creates a node where the pointer is.
  await page.getByTestId("new-workflow").click();
  await page.getByTestId("workflow-editor").waitFor();
  await page.getByText("画布是空的", { exact: true }).waitFor();
  const canvas = await page.getByTestId("workflow-canvas").boundingBox();
  await page.mouse.click(canvas.x + 180, canvas.y + 230, { button: "right" });
  await page.getByTestId("menu-planner").click();
  assert.deepEqual(await counts(), [1, 0]);
  const created = await node("规划者").boundingBox();
  assert.ok(Math.abs(created.x + created.width / 2 - (canvas.x + 180)) < 12 && Math.abs(created.y + created.height / 2 - (canvas.y + 230)) < 12,
    "The node is centred on the right-click");
  // Dragging from the task's dot onto the node connects them.
  await drag(await centre(end("start").locator('[data-port="out"]')), await centre(node("规划者")));
  assert.deepEqual(await counts(), [1, 1]);
  // Letting an edge go over empty canvas offers a node to create there, already connected.
  const from = await centre(port("规划者"));
  await drag(from, { x: from.x + 40, y: from.y + 90 });
  await page.getByText("新建并连接", { exact: true }).waitFor();
  await page.getByTestId("menu-reviewer").click();
  assert.deepEqual(await counts(), [2, 2]);
  // Dragging from the palette drops a node at the pointer.
  await drag(await centre(page.getByTestId("palette-executor")), { x: canvas.x + 470, y: canvas.y + 330 });
  assert.deepEqual(await counts(), [3, 2]);
  await drag(await centre(port("反驳者")), await centre(node("执行者")));
  await drag(await centre(port("执行者")), await centre(end("end")));
  assert.deepEqual(await counts(), [3, 4]);
  // The same edge twice is refused with a reason; nothing changes.
  await drag(await centre(port("反驳者")), await centre(node("执行者")));
  await page.getByText("这两个节点已经连上了", { exact: true }).waitFor();
  assert.deepEqual(await counts(), [3, 4]);
  // An edge back to an earlier node is a loop, and its settings open at once.
  await drag(await centre(port("反驳者")), await centre(node("规划者")));
  await page.getByTestId("edge-inspector").waitFor();
  assert.equal(await page.locator(".wf-loop-label").count(), 1);
  assert.equal(await rounds.inputValue(), "3");
  await page.getByTestId("workflow-checks").getByText("最多启动 7 个 agent", { exact: false }).waitFor();
  await page.screenshot({ path: join(output, "built-by-hand.png") });

  // A node follows the pointer; Delete removes it and its edges, undo brings both back.
  const before = await node("执行者").boundingBox();
  await drag({ x: before.x + 50, y: before.y + 20 }, { x: before.x + 130, y: before.y + 60 });
  const after = await node("执行者").boundingBox();
  assert.ok(Math.abs(after.x - before.x - 80) <= 8 && Math.abs(after.y - before.y - 40) <= 8, "The node moved with the drag, to the grid");
  await page.keyboard.press("Delete");
  assert.deepEqual(await counts(), [2, 3]);
  await page.getByTestId("workflow-undo").click();
  assert.deepEqual(await counts(), [3, 5]);
  // The node menu duplicates; the copy is not part of the flow, which the checks say.
  await node("执行者").click({ button: "right" });
  await page.getByTestId("menu-duplicate").click();
  assert.deepEqual(await counts(), [4, 5]);
  await page.getByTestId("workflow-checks").getByText("没有连线指向「执行者」", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("workflow-run").isDisabled(), true);
  await page.locator(".wf-cnode.selected").click({ button: "right" });
  await page.getByTestId("menu-delete").click();
  assert.deepEqual(await counts(), [3, 5]);
  // Tidy lays the flow out top to bottom.
  await page.getByTestId("workflow-tidy").click();
  await page.waitForTimeout(250);
  const [first, second, third] = await Promise.all(["规划者", "反驳者", "执行者"].map((role) => node(role).boundingBox()));
  assert.ok(first.y < second.y && second.y < third.y && Math.abs(first.x - third.x) < 2);

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
  assert.deepEqual(await page.locator(".wf-session-title em.verdict").allTextContents(), ["需要修改", "通过"]);
  assert.equal(await page.getByTestId("workflow-session").count(), 5);
  assert.deepEqual(await nodes().evaluateAll((items) => items.map((item) => item.dataset.status)), ["done", "done", "done"]);
  await page.screenshot({ path: join(output, "run-completed.png") });

  // One reviewer fails: the one still running is cancelled, and a retry reruns only those two.
  await toLibrary();
  await start("多模型交叉评审", "评审分页接口的改动");
  await settled("failed");
  await page.getByTestId("workflow-failure").getByText("用量窗口已满", { exact: false }).waitFor();
  const statuses = await page.getByTestId("workflow-session").evaluateAll((items) => items.map((item) => item.dataset.status));
  assert.deepEqual([...statuses].sort(), ["cancelled", "done", "failed"]);
  await page.screenshot({ path: join(output, "run-failed.png") });
  await page.getByTestId("workflow-retry").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="workflow-run-status"]')?.dataset.status === "running");
  await settled("completed");
  assert.equal(await page.getByTestId("workflow-failure").count(), 0);
  assert.equal(await page.getByTestId("workflow-session").count(), 6, "Three first attempts, two reruns and the summary");

  // One agent per item of the reviewer's list; stopping cancels them and the task is kept for a rerun.
  await toLibrary();
  await start("缺陷逐项修复", "修复登录流程里发现的问题");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="workflow-session"]').length === 4, null, { timeout: 20_000 });
  await page.getByTestId("workflow-stop").click();
  await settled("cancelled");
  await page.getByTestId("workflow-run-again").click();
  await page.getByTestId("workflow-launch").waitFor();
  assert.equal(await page.getByTestId("workflow-task").inputValue(), "修复登录流程里发现的问题");

  // A workflow Cleo drafts opens on the canvas, unsaved, and does not run until the user confirms it.
  await toLibrary();
  await page.getByTestId("workflow-draft-input").fill("修复设置页在窄屏下的布局缺陷");
  await page.getByTestId("workflow-draft-submit").click();
  await page.getByTestId("workflow-editor").waitFor();
  await page.getByText("尚未保存", { exact: true }).waitFor();
  assert.deepEqual(await counts(), [3, 4]);
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

  // Leaving the page and returning keeps an unsaved edit.
  await page.getByTestId("new-workflow").click();
  await page.getByTestId("workflow-editor").waitFor();
  await page.getByTestId("palette-planner").click();
  await page.getByLabel("工作流名称", { exact: true }).fill("临时流程");
  await page.getByRole("button", { name: "记忆", exact: true }).click();
  await page.getByTestId("memory-view").waitFor();
  await page.getByTestId("open-workflows").click();
  assert.equal(await page.getByLabel("工作流名称", { exact: true }).inputValue(), "临时流程");
  assert.deepEqual(await counts(), [1, 0]);
  await page.locator(".wf-back").click();
  await page.getByTestId("workflow-tab-runs").click();
  assert.equal(await page.getByTestId("workflow-run-row").count(), 5);

  // Opening a conversation leaves the page; the minimum window width keeps the editor usable.
  await page.getByTestId("thread-list").getByRole("button", { name: /修正 Codex 用量显示/ }).first().click();
  await page.getByTestId("conversation").waitFor();
  assert.equal(await page.getByTestId("workflow-view").count(), 0);
  await page.getByTestId("open-workflows").click();
  await page.getByTestId("workflow-tab-workflows").click();
  await page.setViewportSize({ width: 980, height: 680 });
  await page.locator('[data-testid="workflow-card"]', { hasText: "规划 · 反驳 · 执行" }).last().locator(".wf-card-main").click();
  await page.getByTestId("workflow-editor").waitFor();
  const fit = await page.evaluate(() => {
    const view = document.querySelector('[data-testid="workflow-view"]');
    const run = document.querySelector('[data-testid="workflow-run"]').getBoundingClientRect();
    const canvasBox = document.querySelector('[data-testid="workflow-canvas"]').getBoundingClientRect();
    return { overflow: view.scrollWidth - view.clientWidth, runRight: run.right, viewRight: view.getBoundingClientRect().right, canvas: [canvasBox.width, canvasBox.height] };
  });
  assert.equal(fit.overflow, 0, "No horizontal scrolling at the minimum window width");
  assert.ok(fit.runRight <= fit.viewRight, "The run button stays inside the pane");
  assert.ok(fit.canvas[0] >= 480 && fit.canvas[1] >= 400, `The canvas keeps a workable size (${fit.canvas})`);
  await page.screenshot({ path: join(output, "editor-minimum-window.png") });

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "passed", builtByHand: true, runs: 5, failedThenRetried: true, stopped: true, drafted: true, paidModelTurns: 0 }));
} finally {
  await browser?.close();
  await server.close();
  await rm(scratch, { recursive: true, force: true });
}
