import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { snapshot } from "../src/services/mockData.ts";

// A sidebar folder's "显示更多" is forgotten when the folder is closed: reopening it shows the short
// list again, per folder, while the selected thread stays visible without unfolding everything.
const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "cleo-sidebar-"));
const server = await createServer({ root: ui, cacheDir: join(scratch, "vite"), server: { host: "127.0.0.1", port: 0 } });
const FOLDER_LIMIT = 5;
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(({ fixture, limit }) => {
    // Pad two projects past the folder limit so both show "显示更多".
    const template = fixture.threads.find(thread => thread.projectId === "cleo-agent");
    const pad = (projectId, count) => {
      for (let index = 1; index <= count; index++) fixture.threads.push({
        ...structuredClone(template), id: `${projectId}-extra-${index}`, projectId, title: `${projectId} 任务 ${index}`, items: [], changes: [], changeHistory: [],
      });
    };
    pad("cleo-agent", limit + 3 - fixture.threads.filter(thread => thread.projectId === "cleo-agent").length);
    pad("orbit-notes", limit + 2);
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
        if (method === "stream_turn") return null;
        throw new Error(`Unhandled fixture method: ${method}`);
      },
      getEvolutionState: async () => ({ phase: "idle", supported: false, builds: [], releases: [] }),
      onEvolutionState: () => () => {}, confirmHealthy: async () => {}, onStreamEvent: () => () => {},
      getUpdateState: async () => ({ phase: "unsupported", currentVersion: "0.10.2" }),
      onUpdateState: () => () => {},
    };
  }, { fixture: snapshot, limit: FOLDER_LIMIT });
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByTestId("thread-list").waitFor();
  const folder = id => page.locator(`section[data-project-id="${id}"]`);
  const rows = id => folder(id).locator(".thread-row");
  const more = id => folder(id).locator(".thread-more");
  const toggle = id => folder(id).locator(".folder-group-toggle");
  const cleo = "cleo-agent", orbit = "orbit-notes";
  const cleoTotal = FOLDER_LIMIT + 3, orbitTotal = FOLDER_LIMIT + 2;

  assert.equal(await rows(cleo).count(), FOLDER_LIMIT);
  assert.equal(await more(cleo).innerText(), `显示更多（${cleoTotal - FOLDER_LIMIT}）`);
  await more(cleo).click();
  assert.equal(await rows(cleo).count(), cleoTotal);
  assert.equal(await more(cleo).count(), 0);
  await more(orbit).click();
  assert.equal(await rows(orbit).count(), orbitTotal);

  // Closing and reopening the folder returns it to the short list; the other folder keeps its own state.
  for (let round = 0; round < 2; round++) {
    await toggle(cleo).click();
    assert.equal(await toggle(cleo).getAttribute("aria-expanded"), "false");
    assert.equal(await rows(cleo).count(), 0);
    await toggle(cleo).click();
    assert.equal(await toggle(cleo).getAttribute("aria-expanded"), "true");
    assert.equal(await rows(cleo).count(), FOLDER_LIMIT, `Reopened folder kept 显示更多 (round ${round + 1})`);
    assert.equal(await more(cleo).innerText(), `显示更多（${cleoTotal - FOLDER_LIMIT}）`);
    assert.equal(await rows(orbit).count(), orbitTotal, "Closing one folder reset another folder's 显示更多");
    await more(cleo).click();
    assert.equal(await rows(cleo).count(), cleoTotal);
  }

  // A selected thread past the limit stays visible after reopening, on its own rather than unfolding the rest.
  await rows(cleo).last().locator(".thread-row-select").click();
  await folder(cleo).locator(".thread-row.active").waitFor();
  const activeTitle = (await rows(cleo).last().innerText()).split("\n")[0];
  await toggle(cleo).click();
  await toggle(cleo).click();
  assert.equal(await rows(cleo).count(), FOLDER_LIMIT + 1);
  assert.ok((await folder(cleo).locator(".thread-row.active").innerText()).includes(activeTitle), "The selected thread must stay visible");
  assert.equal(await more(cleo).innerText(), `显示更多（${cleoTotal - FOLDER_LIMIT - 1}）`);
  await more(cleo).click();
  assert.equal(await rows(cleo).count(), cleoTotal);
  assert.deepEqual(errors, []);
  console.log("PASS: closing a sidebar folder forgets its 显示更多 per folder and keeps the selected thread visible");
} finally {
  await browser?.close(); await server.close();
  assert.equal(dirname(scratch), resolve(tmpdir()));
  await rm(scratch, { recursive: true, force: true });
}
