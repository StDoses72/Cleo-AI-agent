import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

// Workflows against the offline mock client. The page is where they are kept and drawn: one is
// built by hand on the canvas (right-click, a node described in a sentence, edges pulled between
// nodes) and its nodes are set in the card or the side panel. A workflow runs in a conversation,
// started from the page or with `/workflow`; the saved ones cover a loop, a failure that is
// retried, and a fan-out that is stopped. Two conversations open with a run already in them.
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

  const editor = page.getByTestId("workflow-editor");
  const nodes = () => editor.getByTestId("workflow-node");
  const edges = () => editor.getByTestId("workflow-edge");
  const node = (role) => editor.locator('[data-testid="workflow-node"]', { hasText: role });
  const port = (role) => node(role).locator('[data-port="out"]');
  const end = (id) => editor.locator(`[data-node-id="${id}"]`);
  const tile = (name) => page.locator('[data-testid="workflow-card"]', { hasText: name });
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
  const fitCanvas = () => editor.getByRole("button", { name: "适应画布", exact: true }).click();
  const toLibrary = async () => {
    await page.getByTestId("open-workflows").click();
    // The page comes back where it was left: in a workflow, if one was open.
    await editor.or(page.getByTestId("workflow-list")).first().waitFor();
    if (await editor.count()) await page.getByTestId("workflow-back").click();
    await page.getByTestId("workflow-list").waitFor();
  };
  // The conversation's run: the card in the timeline, and the same run beside it.
  const card = () => page.getByTestId("workflow-run-card").last();
  const panel = page.getByTestId("workflow-run-panel");
  const nodeRun = page.getByTestId("workflow-node-run");
  const strip = () => card().locator(".wf-run-strip li").evaluateAll((items) => items.map((item) => item.dataset.status));
  const send = async (task) => {
    await page.getByTestId("composer-input").fill(task);
    await page.getByTestId("send-button").click();
  };
  const settled = async (expected) => {
    await page.waitForFunction(() => {
      const status = [...document.querySelectorAll('[data-testid="workflow-run-status"]')].at(-1);
      return status && status.dataset.status !== "running";
    }, null, { timeout: 40_000 });
    assert.equal(await card().getByTestId("workflow-run-status").getAttribute("data-status"), expected);
  };
  const startFromLibrary = async (name, task) => {
    await toLibrary();
    await tile(name).getByTestId("workflow-card-run").click();
    await page.getByTestId("workflow-chip").waitFor();
    assert.equal(await page.getByTestId("workflow-view").count(), 0, "Starting a workflow leaves the page for a conversation");
    await send(task);
    await card().waitFor({ timeout: 8_000 });
  };

  await page.goto(server.resolvedUrls.local[0]);
  await page.getByTestId("conversation").waitFor({ timeout: 15_000 });

  // Two conversations already hold a workflow run. One is still going, in the second round of
  // its loop: opening it shows the run where it stands, with its graph beside the conversation.
  const conversation = (name) => page.getByTestId("thread-list").getByRole("button", { name }).first();
  await conversation(/为笔记导出接口补上分页参数的校验/).click();
  await card().waitFor();
  assert.equal(await card().getByTestId("workflow-run-status").getAttribute("data-status"), "running");
  assert.deepEqual(await strip(), ["running", "done", "pending", "pending"]);
  await panel.waitFor();
  assert.equal(await panel.locator(".wf-loop-label").innerText(), "2/3");
  await panel.locator('[data-testid="workflow-node"]', { hasText: "反驳者" }).click();
  assert.deepEqual(await nodeRun.locator("em.verdict").allTextContents(), ["需要修改"]);
  await page.screenshot({ path: join(output, "seeded-running.png") });
  // A node that has started is a conversation of its own. A double click on the graph opens it:
  // what the node was handed, and that it is at work. It is read here, so there is nothing to write in.
  const crumb = page.locator(".breadcrumb strong");
  // A session's timeline arrives a moment after it opens.
  const says = (pattern) => page.waitForFunction((source) => new RegExp(source).test(document.querySelector('[data-testid="conversation"]')?.innerText ?? ""), pattern.source);
  await panel.locator('[data-testid="workflow-node"]', { hasText: "规划者" }).dblclick();
  await page.getByTestId("subtask-parent").waitFor();
  assert.equal(await crumb.innerText(), "规划者 · 第 2 轮");
  await says(/反驳者交来的产出[\s\S]*结论：需要修改/);
  await page.locator(".turn-activity").waitFor();
  assert.equal(await page.getByTestId("composer-input").count(), 0);
  assert.equal(await panel.locator('[data-testid="workflow-session"][data-viewing]').count(), 1, "The graph stays beside the session and marks it");
  // In the list its sessions are folded under the workflow's conversation, which stands for them.
  assert.equal(await page.getByTestId("subtask-row").filter({ hasText: "规划者" }).count(), 0);
  assert.match(await page.locator(".thread-row.active").innerText(), /为笔记导出接口补上/);
  await page.getByTestId("subtask-parent").click();
  await card().waitFor();
  // It is a run like any other: stopping the conversation's run cancels it.
  await page.getByTestId("stop-button").click();
  await settled("cancelled");
  await page.getByTestId("stop-button").waitFor({ state: "detached" });
  // The other finished after one reviewer failed and was retried; the failed attempt is kept.
  await conversation(/评审笔记导出接口的分页改动/).click();
  await card().waitFor();
  assert.equal(await card().getByTestId("workflow-run-status").getAttribute("data-status"), "completed");
  assert.deepEqual(await strip(), ["done", "done", "done", "done"]);
  assert.match(await page.getByTestId("conversation").innerText(), /评审结论：可以合并/);
  await panel.locator('[data-testid="workflow-node"]', { hasText: "可维护性审查" }).click();
  assert.deepEqual(await nodeRun.getByTestId("workflow-session").evaluateAll((items) => items.map((item) => item.dataset.status)), ["failed", "done"]);
  await page.screenshot({ path: join(output, "seeded-finished.png") });
  // Unfolded in the list, each of its node sessions can be picked there: the retry, and the
  // attempt that failed before it.
  const listed = page.getByTestId("subtask-row").filter({ hasText: "可维护性审查" });
  await page.locator(".thread-row", { hasText: "评审笔记导出接口" }).getByTestId("node-sessions-toggle").click();
  assert.equal(await listed.count(), 2);
  await listed.last().locator(".thread-row-select").click();
  await page.getByTestId("subtask-parent").waitFor();
  assert.equal(await crumb.innerText(), "可维护性审查 · 重试");
  await says(/只看可维护性[\s\S]*loadPage 与 loadMore/);
  assert.match(await page.locator(".thread-row.active").innerText(), /可维护性审查/);
  await page.screenshot({ path: join(output, "node-session.png") });
  await listed.first().locator(".thread-row-select").click();
  await page.waitForFunction(() => document.querySelector(".breadcrumb strong")?.textContent === "可维护性审查");
  await says(/没有完成[\s\S]*用量窗口已满/);
  // A double click on the graph opens a node directly; the node reads what the three before it produced.
  await panel.locator('[data-testid="workflow-node"]', { hasText: "汇总者" }).dblclick();
  await page.waitForFunction(() => document.querySelector(".breadcrumb strong")?.textContent === "汇总者");
  await says(/正确性审查交来的产出[\s\S]*安全审查交来的产出[\s\S]*可维护性审查交来的产出/);
  await page.getByTestId("subtask-parent").click();
  await card().waitFor();
  assert.equal(await crumb.innerText(), "评审笔记导出接口的分页改动");

  await page.getByTestId("open-workflows").click();
  await page.getByTestId("workflow-list").waitFor();
  assert.equal(await page.getByTestId("workflow-card").count(), 3);
  assert.equal(await page.getByTestId("workflow-roles").locator("li").count(), 1, "One node definition is kept for reuse");
  assert.equal(await page.locator(".inspector").count(), 0, "The workflows page takes the details column too");
  await page.screenshot({ path: join(output, "library.png") });

  // A saved workflow opens as a graph; its loop is an edge with a round limit.
  await tile("规划 · 反驳 · 执行").locator(".wf-tile-open").click();
  await editor.waitFor();
  assert.deepEqual(await counts(), [4, 6]);
  assert.equal(await page.getByTestId("workflow-save").isDisabled(), true, "Nothing to save before an edit");
  assert.equal(await page.getByTestId("node-detail").count(), 0, "A node's settings stay closed until it is opened");
  await editor.locator(".wf-loop-label").click();
  const rounds = page.getByTestId("loop-rounds");
  assert.equal(await rounds.inputValue(), "3");
  await rounds.fill("9");
  assert.equal(await page.getByTestId("workflow-run").isDisabled(), true);
  await page.getByTestId("workflow-issues").click();
  assert.equal(await page.getByTestId("workflow-checks").locator("li").count(), 1);
  await page.keyboard.press("Escape");
  await editor.locator(".wf-loop-label").click();
  await rounds.fill("3");
  assert.equal(await page.getByTestId("workflow-issues").count(), 0);

  // What a node is set to opens beside it, or in a panel at the side; the choice is remembered.
  await node("反驳者").click();
  const detail = page.getByTestId("node-detail");
  await detail.waitFor();
  assert.match(await detail.getAttribute("class"), /\bcard\b/);
  assert.match(await detail.locator('[data-field="instructions"]').inputValue(), /找出方案里会失败的地方/);
  assert.equal(await detail.locator('[data-field="harness"]').inputValue(), "codex");
  await page.screenshot({ path: join(output, "node-card.png") });
  await page.getByTestId("detail-panel").click();
  assert.match(await detail.getAttribute("class"), /\bpanel\b/);
  await page.screenshot({ path: join(output, "node-panel.png") });
  await page.getByTestId("workflow-back").click();
  await tile("多模型交叉评审").locator(".wf-tile-open").click();
  await editor.waitFor();
  await node("汇总者").click();
  assert.match(await detail.getAttribute("class"), /\bpanel\b/, "The panel is still the choice in another workflow");
  await page.getByTestId("detail-card").click();
  assert.match(await detail.getAttribute("class"), /\bcard\b/);
  await page.getByTestId("workflow-back").click();

  // Building by hand. A blank node asks what it should do, and Cleo writes its definition.
  await page.getByTestId("new-workflow").click();
  await editor.waitFor();
  assert.deepEqual(await counts(), [0, 0]);
  assert.equal(await page.getByTestId("workflow-run").isDisabled(), true);
  const canvas = await page.getByTestId("workflow-canvas").boundingBox();
  await page.mouse.click(canvas.x + 420, canvas.y + 260, { button: "right" });
  await page.getByTestId("menu-blank").click();
  await page.getByTestId("node-intent").fill("先把任务拆成可验证的步骤");
  await page.keyboard.press("Enter");
  await node("规划者").waitFor({ timeout: 5_000 });
  assert.deepEqual(await counts(), [1, 0]);
  assert.equal(await node("规划者").locator(".wf-cnode-marks .drafted").count(), 1, "A drafted definition is marked until it is opened");
  // An edge is pulled from the dot under a node. Pulling one does not open the node.
  await drag(await centre(end("start").locator('[data-port="out"]')), await centre(node("规划者")));
  assert.deepEqual(await counts(), [1, 1]);
  // Let go over empty canvas: the node chosen there arrives already connected.
  const from = await centre(port("规划者"));
  await drag(from, { x: from.x, y: from.y + 90 });
  await page.getByTestId("menu-executor").click();
  assert.deepEqual(await counts(), [2, 2]);
  // The node made from the menu opens; the keyboard is back on the canvas, so Escape closes it.
  await page.getByTestId("node-detail").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByTestId("node-detail").count(), 0);
  await fitCanvas();
  await drag(await centre(port("执行者")), await centre(end("end")));
  assert.deepEqual(await counts(), [2, 3]);
  assert.equal(await page.getByTestId("node-detail").count(), 0, "Pulling an edge out of a node leaves its settings closed");
  assert.equal(await page.getByTestId("workflow-issues").count(), 0);
  assert.equal(await page.getByTestId("workflow-run").isDisabled(), false);
  // The same edge twice is refused; nothing changes.
  await drag(await centre(port("执行者")), await centre(end("end")));
  assert.deepEqual(await counts(), [2, 3]);
  // An edge back to an earlier node is a loop, and its settings open at once.
  await drag(await centre(port("执行者")), await centre(node("规划者")));
  assert.equal(await editor.locator(".wf-loop-label").count(), 1);
  assert.equal(await page.getByTestId("loop-rounds").inputValue(), "3");
  await page.getByTestId("edge-delete").click();
  assert.deepEqual(await counts(), [2, 3]);

  // A node is set in its card: where it runs, and what it is allowed to do.
  await node("规划者").click();
  await detail.waitFor();
  assert.equal(await node("规划者").locator(".wf-cnode-marks .drafted").count(), 0);
  assert.match(await detail.locator('[data-field="instructions"]').inputValue(), /先把任务拆成可验证的步骤/);
  await detail.locator('[data-field="harness"]').selectOption("codex");
  assert.notEqual(await detail.locator('[data-field="model"]').inputValue(), "", "A harness brings its default model");
  assert.match(await node("规划者").locator(".wf-cnode-copy small").innerText(), /Codex/);
  assert.equal(await detail.locator('[data-field="harness"] option[value="antigravity"]').isDisabled(), true, "A harness that is not signed in cannot be chosen");
  await detail.locator(".wf-card-more summary").click();
  assert.equal(await node("规划者").locator(".wf-cnode-marks em").count(), 0);
  await detail.getByTestId("limit-write").check();
  assert.equal(await node("规划者").locator(".wf-cnode-marks em").count(), 1, "A node that may edit files says so on the canvas");
  await detail.getByTestId("limit-write").uncheck();
  // One sentence rewrites the definition; the name the user sees stays theirs to change.
  await detail.getByTestId("node-redraft").fill("审查方案有没有遗漏");
  await page.keyboard.press("Enter");
  await node("审查者").waitFor({ timeout: 5_000 });
  await page.getByTestId("workflow-undo").click();
  await node("规划者").waitFor();
  // A definition worth keeping is saved for reuse, and offered wherever a node is created.
  await node("规划者").click();
  await detail.locator(".wf-card-name").fill("拆解者");
  await page.getByTestId("node-keep").click();
  await page.getByText("已保存节点「拆解者」").waitFor();
  await page.keyboard.press("Escape");
  await page.mouse.click(canvas.x + 120, canvas.y + 600, { button: "right" });
  assert.equal(await page.getByTestId("workflow-menu").getByText("拆解者", { exact: true }).count(), 1);
  assert.equal(await page.getByTestId("workflow-menu").getByText("安全审查", { exact: true }).count(), 1);
  await page.keyboard.press("Escape");

  // A node follows the pointer; Delete removes it and its edges, undo brings both back.
  await node("执行者").click();
  await page.keyboard.press("Escape");
  const before = await node("执行者").boundingBox();
  await drag({ x: before.x + 60, y: before.y + 30 }, { x: before.x + 140, y: before.y + 70 });
  const after = await node("执行者").boundingBox();
  assert.ok(Math.abs(after.x - before.x - 80) <= 8 && Math.abs(after.y - before.y - 40) <= 8, "The node moved with the drag, to the grid");
  await page.keyboard.press("Escape");
  await node("执行者").focus();
  await page.keyboard.press("Delete");
  assert.deepEqual(await counts(), [1, 1]);
  await page.getByTestId("workflow-undo").click();
  assert.deepEqual(await counts(), [2, 3]);
  // Tidy lays the flow out top to bottom.
  await page.getByTestId("workflow-tidy").click();
  const [first, second] = [await node("拆解者").boundingBox(), await node("执行者").boundingBox()];
  assert.ok(first.y < second.y && Math.abs(first.x - second.x) < 2);
  await page.getByLabel("工作流名称", { exact: true }).fill("手工流程");
  await page.keyboard.press("Escape");
  await page.screenshot({ path: join(output, "built-by-hand.png") });

  // Run: the workflow is kept, and a conversation opens with it chosen. It needs a task to start.
  await page.getByTestId("workflow-run").click();
  await page.getByTestId("workflow-chip").waitFor({ timeout: 8_000 });
  assert.equal(await page.getByTestId("workflow-chip").innerText(), "手工流程");
  assert.equal(await page.getByTestId("workflow-view").count(), 0);
  await page.getByTestId("composer-input").press("Enter");
  assert.equal(await page.getByTestId("workflow-run-card").count(), 0, "No agent starts without a task");
  await send("给会话导出接口加上分页");
  await card().waitFor({ timeout: 8_000 });
  await panel.waitFor();
  await settled("completed");
  assert.deepEqual(await strip(), ["done", "done"]);
  assert.equal(await page.getByTestId("conversation").getByText("/workflow").count(), 0, "The conversation shows the task, not the command");
  assert.ok(await page.getByTestId("thread-list").getByRole("button", { name: /给会话导出接口加上分页/ }).count(), "The conversation is named after the task");
  // Beside the conversation: the graph, and for the node that is picked, what it was told and what it did.
  await panel.getByTestId("workflow-node").first().click();
  await nodeRun.waitFor();
  assert.equal(await nodeRun.getByTestId("workflow-session").count(), 1);
  await nodeRun.locator(".wf-node-brief summary").click();
  assert.match(await nodeRun.locator(".wf-node-brief pre").innerText(), /先把任务拆成可验证的步骤/);
  await page.screenshot({ path: join(output, "run-in-conversation.png") });

  // `/workflow` in a conversation that already exists. One reviewer fails: the one still running
  // is cancelled, and a retry reruns only those two.
  await page.getByTestId("thread-list").getByRole("button", { name: /修正 Codex 用量显示/ }).first().click();
  await page.getByTestId("composer-input").fill("/work");
  await page.getByTestId("slash-menu").waitFor();
  assert.equal(await page.getByTestId("slash-workflow").count(), 4, "Every saved workflow can be started from the composer");
  await page.getByTestId("slash-workflow").filter({ hasText: "多模型交叉评审" }).click();
  assert.equal(await page.getByTestId("workflow-chip").innerText(), "多模型交叉评审");
  await send("评审分页接口的改动");
  await card().waitFor({ timeout: 8_000 });
  await settled("failed");
  assert.deepEqual((await strip()).sort(), ["cancelled", "done", "failed", "pending"]);
  assert.match(await page.getByTestId("workflow-failure").innerText(), /可维护性审查/);
  await page.screenshot({ path: join(output, "run-failed.png") });
  await page.getByTestId("workflow-retry").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="workflow-run-status"]')?.dataset.status === "running");
  await settled("completed");
  assert.equal(await page.getByTestId("workflow-run-card").count(), 1, "A retry continues the same run");
  assert.deepEqual(await strip(), ["done", "done", "done", "done"]);
  assert.equal(await page.getByTestId("workflow-failure").count(), 0);
  assert.equal(await panel.locator(".wf-run-facts dd").nth(2).innerText(), "6", "Three first attempts, two reruns and the summary");

  // The loop takes a second round because the judge sent the first plan back.
  await startFromLibrary("规划 · 反驳 · 执行", "为导出接口补上分页参数的校验");
  await settled("completed");
  await panel.locator('[data-testid="workflow-node"]', { hasText: "反驳者" }).click();
  assert.deepEqual(await nodeRun.locator("em.verdict").allTextContents(), ["需要修改", "通过"]);
  assert.equal(await nodeRun.getByTestId("workflow-session").count(), 2);
  await page.screenshot({ path: join(output, "run-loop.png") });

  // One agent per item of the reviewer's list; stopping the conversation's run cancels them.
  await startFromLibrary("缺陷逐项修复", "修复登录流程里发现的问题");
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="workflow-run-card"] .wf-run-strip li')]
    .some((item) => item.textContent.includes("修复者") && item.dataset.status === "running"), null, { timeout: 20_000 });
  await panel.locator('[data-testid="workflow-node"]', { hasText: "修复者" }).click();
  assert.equal(await nodeRun.getByTestId("workflow-session").count(), 3, "One agent for each of the three defects");
  await page.getByTestId("stop-button").click();
  await settled("cancelled");
  assert.ok((await strip()).includes("cancelled"));

  // A workflow Cleo drafts opens on the canvas, unsaved; it is kept like one built by hand.
  await toLibrary();
  await page.getByTestId("workflow-draft-input").fill("修复设置页在窄屏下的布局缺陷");
  await page.getByTestId("workflow-draft-submit").click();
  await editor.waitFor({ timeout: 8_000 });
  assert.deepEqual(await counts(), [3, 4]);
  assert.equal(await page.getByTestId("workflow-state").innerText(), "未保存");
  await page.getByTestId("workflow-save").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="workflow-state"]')?.classList.contains("saved"));
  await page.getByTestId("workflow-back").click();
  assert.equal(await page.getByTestId("workflow-card").count(), 5);
  assert.equal(await page.getByTestId("workflow-roles").locator("li").count(), 2);

  // Leaving the page and returning keeps an unsaved edit.
  await page.getByTestId("new-workflow").click();
  await editor.waitFor();
  await page.getByTestId("workflow-add").click();
  await page.getByTestId("menu-planner").click();
  await page.getByLabel("工作流名称", { exact: true }).fill("临时流程");
  await page.getByRole("button", { name: "记忆", exact: true }).click();
  await page.getByTestId("memory-view").waitFor();
  await page.getByTestId("open-workflows").click();
  assert.equal(await page.getByLabel("工作流名称", { exact: true }).inputValue(), "临时流程");
  assert.deepEqual(await counts(), [1, 0]);
  await page.getByTestId("workflow-back").click();

  // The minimum window width keeps the editor usable.
  await page.setViewportSize({ width: 980, height: 680 });
  await tile("规划 · 反驳 · 执行").locator(".wf-tile-open").click();
  await editor.waitFor();
  const fit = await page.evaluate(() => {
    const view = document.querySelector('[data-testid="workflow-view"]');
    const run = document.querySelector('[data-testid="workflow-run"]').getBoundingClientRect();
    const canvasBox = document.querySelector('[data-testid="workflow-canvas"]').getBoundingClientRect();
    return { overflow: view.scrollWidth - view.clientWidth, runRight: run.right, viewRight: view.getBoundingClientRect().right, canvas: [canvasBox.width, canvasBox.height] };
  });
  assert.equal(fit.overflow, 0, "No horizontal scrolling at the minimum window width");
  assert.ok(fit.runRight <= fit.viewRight, "The run button stays inside the pane");
  assert.ok(fit.canvas[0] >= 480 && fit.canvas[1] >= 400, `The canvas keeps a workable size (${fit.canvas})`);
  await node("反驳者").click();
  await detail.waitFor();
  const cardBox = await detail.boundingBox();
  assert.ok(cardBox.x >= 0 && cardBox.x + cardBox.width <= 980 && cardBox.y + cardBox.height <= 680, "The node's card stays inside the window");
  await page.screenshot({ path: join(output, "editor-minimum-window.png") });

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "passed", builtByHand: true, runsInConversations: 4, failedThenRetried: true, stopped: true, drafted: true, paidModelTurns: 0 }));
} finally {
  await browser?.close();
  await server.close();
  await rm(scratch, { recursive: true, force: true });
}
