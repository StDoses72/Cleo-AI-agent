import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { snapshot } from "../src/services/mockData.ts";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "cleo-running-recovery-"));
const server = await createServer({ root: ui, cacheDir: join(scratch, "vite"), server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  const data = structuredClone(snapshot);
  data.activeThreadId = "desktop-ui";
  const one = data.threads.find(t => t.id === "desktop-ui");
  const two = data.threads.find(t => t.id === "session-hub");
  for (const thread of [one, two]) {
    thread.status = "running"; thread.activeRunId = `server-${thread.id}`;
    thread.history = { before: "0", after: "5", total: thread.items.length, revision: "1", hasBefore: false, hasAfter: false };
  }
  one.pendingApprovals = [{ id: "approval", threadId: one.id, kind: "command", command: "recoverable command", reason: "test", cwd: "fixture", commandActions: [], availableDecisions: ["accept", "cancel"] }];
  const cancelled = []; const activated = [];
  let failRead = true;
  let replaceBeforeCancel = true;
  await page.exposeFunction("recoveryRequest", async (method, params = {}) => {
    if (method === "load_workspace") return data;
    if (method === "load_memory") return { memories: data.memories, memoryOverview: data.memoryOverview };
    if (method === "get_runtime_catalog") return { nonProductivityProfiles: [], defaultNonProductivityProfile: "", defaultProductivityProvider: "codex", productivityProviders: [{ id: "codex", type: "codex_sdk", defaultModel: "test" }] };
    if (method === "get_productivity_models") return { provider: "codex", source: "sdk", models: [] };
    if (method === "get_pending_questions") return [];
    if (method === "load_thread") {
      if (params.activate !== false) activated.push(params.thread_id);
      if (params.activate === false && params.thread_id === one.id && failRead) throw new Error("temporary recovery failure");
      return data.threads.find(t => t.id === params.thread_id);
    }
    if (method === "load_timeline") { const thread = data.threads.find(t => t.id === params.thread_id); return { ...thread.history, items: thread.items }; }
    if (method === "cancel_run") {
      cancelled.push(params);
      const thread = data.threads.find(t => t.id === params.thread_id);
      if (replaceBeforeCancel) {
        replaceBeforeCancel = false;
        thread.activeRunId = "new-server-run";
        return { cancelled: false };
      }
      assert.equal(params.run_id, thread.activeRunId);
      thread.status = "attention"; thread.activeRunId = null; thread.pendingApprovals = [];
      return { cancelled: true };
    }
    throw new Error(`Unhandled recovery request: ${method}`);
  });
  await page.addInitScript(() => {
    window.cleoDesktop = {
      request: (method, params) => window.recoveryRequest(method, params), onStreamEvent: () => () => {},
      getEvolutionState: async () => ({ phase: "idle", builds: [], releases: [], supported: false }),
      onEvolutionState: () => () => {}, confirmHealthy: async () => {},
      getUpdateState: async () => ({ phase: "unsupported", currentVersion: "test" }), onUpdateState: () => () => {},
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByRole("alert").filter({ hasText: "temporary recovery failure" }).waitFor();
  assert.equal(await page.getByTestId("stop-button").isVisible(), true, "A failed observation must not end a run");
  failRead = false;
  await page.getByRole("alert").filter({ hasText: "temporary recovery failure" }).waitFor({ state: "hidden" });
  await page.getByTestId("approval-prompt").getByText("recoverable command", { exact: true }).waitFor();
  await page.getByRole("button", { name: /^统一 managed 与 native sessions/ }).click();
  await page.getByTestId("composer-input").fill("recovered draft");
  await page.getByTestId("stop-button").click();
  assert.equal(await page.getByTestId("stop-button").isVisible(), true, "A stale stop acknowledgement must not mark a new run stopped");
  // Wait for the regular recovery read to adopt the new run, then stop that exact run.
  await page.waitForTimeout(1800);
  await page.getByTestId("stop-button").click();
  await page.getByTestId("stop-button").waitFor({ state: "hidden" });
  assert.deepEqual(cancelled, [
    { thread_id: two.id, run_id: "server-session-hub" },
    { thread_id: two.id, run_id: "new-server-run" },
  ]);
  assert.equal(one.activeRunId, "server-desktop-ui");
  one.activeRunId = null; one.status = "completed"; one.pendingApprovals = [];
  await page.waitForFunction(() => [...document.querySelectorAll('.thread-row')].find(row =>
    row.querySelector('.thread-title-line strong')?.textContent === '完成独立桌面 UI')?.getAttribute('data-status') === 'completed');
  assert.equal(await page.getByTestId("composer-input").inputValue(), "recovered draft");
  assert.equal(activated.every(id => id === two.id), true, "Background refresh changed the backend selection");
  assert.deepEqual(errors, []);
  console.log("PASS: recover running tasks and approvals, tolerate failed reads, cancel by run ID, preserve navigation and drafts");
} finally {
  await browser?.close(); await server.close();
  assert.equal(dirname(scratch), resolve(tmpdir()));
  await rm(scratch, { recursive: true, force: true });
}
