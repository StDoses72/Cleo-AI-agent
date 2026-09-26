import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "cleo-concurrent-"));
const server = await createServer({ root: ui, cacheDir: join(scratch, "vite"), server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(7000);
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByTestId("composer-input").waitFor();
  await page.evaluate(async () => {
    const { cleoClient } = await import("/src/services/cleoClient.ts");
    const snapshot = await cleoClient.loadWorkspace();
    const rows = new Map(snapshot.threads.map(thread => [thread.id, [...thread.items]]));
    const active = new Map();
    const pendingQuestions = new Map();
    window.runs = active; window.cancelledRuns = []; window.decisions = []; window.historyLoads = [];
    window.answers = []; window.answerWaiters = new Map();
    const pageOf = id => {
      const items = rows.get(id).map((item, order) => ({ ...item, order, cursor: String(order) }));
      return { items, before: "0", after: String(items.length - 1), total: items.length, hasBefore: false, hasAfter: false, revision: String(items.length) };
    };
    cleoClient.loadTimeline = async id => { window.historyLoads.push(id); return pageOf(id); };
    cleoClient.loadThread = async id => {
      const { items, ...history } = pageOf(id);
      const loaded = { ...snapshot.threads.find(t => t.id === id), items, history, status: active.has(id) ? "running" : "completed" };
      if (window.deferThread === id) {
        window.deferThread = null;
        await new Promise(resolve => { window.releaseThreadRead = resolve; });
      }
      return loaded;
    };
    cleoClient.streamTurn = async function* (id, prompt, _attachments, runId) {
      const queue = []; let wake; let finished = false;
      const emit = event => {
        if (event.type === "upsert-item" || event.type === "turn-started") {
          const stored = rows.get(id);
          const index = stored.findIndex(item => item.id === event.item.id);
          const order = index < 0 ? stored.length : index;
          event.item = { ...event.item, order, cursor: String(order), turnId: runId };
          if (index < 0) stored.push(event.item); else stored[index] = event.item;
        }
        queue.push(event); wake?.(); wake = null;
      };
      const run = { runId, emit, finish: () => { finished = true; wake?.(); } };
      active.set(id, run);
      emit({ type: "turn-started", item: { id: `${id}:${runId}`, type: "message", role: "user", content: prompt, time: "" } });
      try {
        while (!finished || queue.length) {
          if (!queue.length) await new Promise(resolve => { wake = resolve; });
          while (queue.length) yield queue.shift();
        }
      } finally { if (active.get(id) === run) active.delete(id); }
    };
    cleoClient.cancelRun = async (id, runId) => {
      window.cancelledRuns.push({ id, runId });
      const run = active.get(id);
      if (run?.runId === runId) { run.emit({ type: "error", message: "cancelled" }); run.finish(); }
    };
    cleoClient.resolveApproval = async (threadId, approvalId, decision) => {
      window.decisions.push({ threadId, approvalId, decision });
      active.get(threadId).emit({ type: "approval-resolved", response: { id: approvalId, decision } });
    };
    cleoClient.getPendingQuestions = async id => pendingQuestions.has(id) ? [pendingQuestions.get(id)] : [];
    cleoClient.resolveQuestion = async (threadId, questionId, answers) => {
      window.answers.push({ threadId, questionId, answers });
      await new Promise(resolve => window.answerWaiters.set(threadId, resolve));
      const request = { ...pendingQuestions.get(threadId), status: "answered", answers };
      pendingQuestions.delete(threadId);
      active.get(threadId).emit({ type: "question-resolved", request });
    };
    window.askQuestion = id => {
      const request = { id: "same-question-id", threadId: id, provider: "codex", status: "pending",
        questions: [{ id: "detail", header: "补充", question: `Question for ${id}`, multiple: false, options: [] }] };
      pendingQuestions.set(id, request);
      active.get(id).emit({ type: "question-request", request });
    };
    window.askApproval = id => active.get(id).emit({ type: "approval-request", request: {
      id: "same-provider-request", threadId: id, kind: "command", method: "test", turnId: active.get(id).runId,
      itemId: "tool", command: `command for ${id}`, reason: "test permission", cwd: "fixture",
      availableDecisions: ["accept", "decline", "cancel"], commandActions: [], permissions: null, grantRoot: null, startedAtMs: 0,
    } });
  });
  const selectA = () => page.getByRole("button", { name: /^完成独立桌面 UI/ }).click();
  const selectB = () => page.getByRole("button", { name: /^统一 managed 与 native sessions/ }).click();
  await page.getByTestId("composer-input").fill("A running");
  await page.getByTestId("send-button").click();
  await page.waitForFunction(() => window.runs.has("desktop-ui"));
  await selectB();
  await page.getByTestId("composer-input").fill("B running");
  assert.equal(await page.getByTestId("send-button").isEnabled(), true, "Another task must not disable this task");
  await page.getByTestId("send-button").click();
  await page.waitForFunction(() => window.runs.size === 2);
  await page.evaluate(() => {
    for (const [id, content] of [["desktop-ui", "A live reply"], ["session-hub", "B live reply"]]) {
      window.runs.get(id).emit({ type: "upsert-item", item: { id: "answer", type: "message", role: "assistant", content, time: "" } });
    }
  });
  await page.getByText("B live reply", { exact: true }).waitFor();
  if (process.env.CLEO_SMOKE_OUTPUT) await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "concurrent-tasks.png") });
  await page.getByRole("button", { name: "删除 修正 Codex 用量显示", exact: true }).click();
  await page.getByRole("button", { name: "永久删除", exact: true }).click();
  await page.getByRole("alertdialog").waitFor({ state: "hidden" });
  assert.equal(await page.getByText("B live reply", { exact: true }).isVisible(), true, "A stale workspace response erased a live reply");
  await page.evaluate(() => { window.deferThread = "desktop-ui"; });
  await selectA();
  await page.waitForFunction(() => Boolean(window.releaseThreadRead));
  await page.getByText("A live reply", { exact: true }).waitFor();
  assert.equal(await page.getByText("B live reply", { exact: true }).count(), 0);
  await page.evaluate(() => window.runs.get("desktop-ui").emit({ type: "upsert-item", item: {
    id: "answer", type: "message", role: "assistant", content: "A latest reply", time: "",
  } }));
  await page.getByText("A latest reply", { exact: true }).waitFor();
  await page.evaluate(() => window.releaseThreadRead());
  await page.waitForTimeout(100);
  assert.equal(await page.getByText("A latest reply", { exact: true }).isVisible(), true, "Late task selection erased a newer stream update");
  await page.evaluate(() => { window.askApproval("desktop-ui"); window.askApproval("session-hub"); });
  await page.getByTestId("approval-once").click();
  assert.deepEqual(await page.evaluate(() => window.decisions), [{ threadId: "desktop-ui", approvalId: "same-provider-request", decision: "accept" }]);
  await selectB();
  await page.getByTestId("approval-prompt").getByText("command for session-hub", { exact: true }).waitFor();
  await page.getByTestId("approval-once").click();
  await page.evaluate(() => { window.askQuestion("desktop-ui"); window.askQuestion("session-hub"); });
  const dialog = page.getByRole("dialog", { name: "Agent 提问" });
  await dialog.getByLabel("你的回答").fill("B answer");
  await dialog.getByRole("button", { name: "稍后回答", exact: true }).click();
  await selectA();
  await dialog.getByText("Question for desktop-ui", { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel("你的回答").inputValue(), "", "Question drafts leaked between tasks");
  await dialog.getByLabel("你的回答").fill("A answer");
  await dialog.getByRole("button", { name: "提交答案", exact: true }).click();
  await dialog.getByRole("button", { name: "正在提交…", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "稍后回答", exact: true }).click();
  await selectB();
  await page.getByRole("button", { name: "回答问题", exact: true }).click();
  assert.equal(await dialog.getByLabel("你的回答").inputValue(), "B answer");
  assert.equal(await dialog.getByRole("button", { name: "提交答案", exact: true }).isEnabled(), true);
  await dialog.getByRole("button", { name: "提交答案", exact: true }).click();
  await page.waitForFunction(() => window.answerWaiters.size === 2);
  await page.evaluate(() => window.answerWaiters.get("desktop-ui")());
  await page.waitForFunction(() => document.querySelector('[aria-label="Agent 提问"]')?.textContent.includes("Question for session-hub"));
  assert.equal(await dialog.getByRole("button", { name: "正在提交…", exact: true }).isDisabled(), true);
  await page.evaluate(() => window.answerWaiters.get("session-hub")());
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => window.answers), [
    { threadId: "desktop-ui", questionId: "same-question-id", answers: { detail: ["A answer"] } },
    { threadId: "session-hub", questionId: "same-question-id", answers: { detail: ["B answer"] } },
  ]);
  await page.getByTestId("stop-button").click();
  await page.getByTestId("stop-button").waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => window.cancelledRuns.map(value => value.id)), ["session-hub"]);
  assert.equal(await page.evaluate(() => window.runs.has("desktop-ui")), true);
  await page.getByTestId("composer-input").fill("B unsent draft");
  await page.evaluate(() => { window.historyLoads = []; const run = window.runs.get("desktop-ui"); run.emit({ type: "done", summary: "A done" }); run.finish(); });
  await page.waitForFunction(() => window.runs.size === 0);
  assert.equal(await page.getByTestId("composer-input").inputValue(), "B unsent draft");
  assert.equal(await page.evaluate(() => window.historyLoads.includes("session-hub")), false, "Background completion reloaded the foreground task");
  await selectA();
  await page.getByText("A latest reply", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("stop-button").count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: concurrent streams, stale snapshots, task-scoped approvals, question drafts/submissions, cancellation and background completion");
} finally {
  await browser?.close(); await server.close();
  assert.equal(dirname(scratch), resolve(tmpdir()));
  await rm(scratch, { recursive: true, force: true });
}
