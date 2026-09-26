import assert from "node:assert/strict";
import { chromium, _electron as electron } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { snapshot } from "../src/services/mockData.ts";

// Exercise the real App, workspace hook and IPC stream with disposable, controlled sessions.
const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "cleo-isolation-ui-"));
const server = createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname;
  const path = resolve(ui, "dist", name === "/" ? "index.html" : `.${name}`);
  if (!path.startsWith(resolve(ui, "dist") + sep)) { response.writeHead(403).end(); return; }
  try {
    response.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html");
    response.end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
let app;
let page;
const failures = [];
try {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  if (process.env.CLEO_TEST_BROWSER) {
    app = await chromium.launch({ executablePath: process.env.CLEO_TEST_BROWSER, headless: true });
    page = await app.newPage({ viewport: { width: 1280, height: 900 } });
  } else {
    app = await electron.launch({ args: [".", `--user-data-dir=${join(root, "profile")}`], cwd: ui,
      env: { ...process.env, CLEO_DESKTOP_MOCK: "1", CLEO_HOME: join(root, "home") } });
    page = await app.firstWindow();
  }
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ fixture }) => {
    const workspace = structuredClone(fixture);
    const runtime = { provider: "codex", model: "test", effort: "low", editable: true };
    const message = (id, content, role = "assistant") => ({ id, content, role, type: "message", time: "12:00" });
    const makeThread = (id, projectId, content) => ({ ...fixture.threads[0], id, projectId, space: "productivity",
      title: id, items: [message(`${id}-history`, content)], changes: [], status: "idle", runtime,
      history: { total: 1, hasBefore: false, hasAfter: false, before: null, after: null } });
    const dev = makeThread("development", "productivity:work", "DEV HISTORY");
    const otherDev = makeThread("development-two", dev.projectId, "DEV OTHER HISTORY");
    const evo = makeThread("evolution", "productivity:cleo-evolution", "EVOLUTION HISTORY");
    workspace.projects = [
      { id: dev.projectId, name: "Work", space: "productivity", path: "fixture/dev", accent: "cyan" },
      { id: evo.projectId, name: "Cleo", space: "productivity", path: "fixture/evo", accent: "cyan" },
    ];
    workspace.threads = [evo, dev, otherDev]; workspace.activeThreadId = dev.id;
    const options = new URLSearchParams(location.search);
    if (options.has("last-evolution")) workspace.activeThreadId = evo.id;
    if (options.has("only-evolution")) { workspace.threads = [evo]; workspace.projects = workspace.projects.slice(1); }
    if (options.has("new")) workspace.threads = [dev, otherDev];
    const state = { phase: "idle", supported: true, prepared: true, currentVersion: "test", active: "base",
      baseline: "base", source: "fixture/evo", threadId: options.has("new") ? "" : evo.id,
      builds: [], releases: [], acceptanceRequests: [], logs: "" };
    const listeners = new Set();
    const streams = new Map();
    let stateListener = () => {};
    let releaseOpen;
    let releasePrepare;
    const copy = (value) => structuredClone(value);
    const publish = () => stateListener(copy(state));
    const emit = (threadId, event) => {
      const stream = streams.get(threadId);
      assertStream(stream);
      for (const listener of listeners) listener({ streamId: stream.id, event });
    };
    function assertStream(stream) { if (!stream) throw new Error("Missing test stream"); }
    window.isolation = {
      workspace, streams, calls: [], listening: () => listeners.size,
      releaseOpen: () => releaseOpen?.(), releasePrepare: () => releasePrepare?.(),
      chunk(threadId, text) {
        const thread = threadId === evo.id ? evo : dev;
        const item = message(`${threadId}-reply`, text);
        thread.items = [...thread.items.filter((entry) => entry.id !== item.id), item];
        emit(threadId, { type: "upsert-item", item });
      },
      refresh(threadId) { emit(threadId, { type: "refresh", activeThreadId: threadId, space: "productivity" }); },
      finish(threadId) { emit(threadId, { type: "done", summary: "Complete" }); streams.get(threadId).done(); },
    };
    localStorage.setItem("cleo-view", "workspace");
    window.cleoDesktop = {
      getEvolutionState: async () => copy(state),
      onEvolutionState: (listener) => { stateListener = listener; return () => {}; },
      confirmHealthy: async () => {}, getUpdateState: async () => ({ phase: "idle" }), onUpdateState: () => () => {},
      onStreamEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      evolutionAction: async (action, params) => {
        if (action === "thread") { state.threadId = params.id; publish(); return; }
        if (action === "prepareRequest") {
          window.isolation.calls.push("prepare");
          if (options.has("hold-prepare")) await new Promise((done) => { releasePrepare = done; });
          return { id: params.id, threadId: params.threadId, prompt: params.prompt, status: "frozen" };
        }
        if (action === "requestPrompt") return "EVOLUTION REQUEST";
        throw new Error(`Unexpected action: ${action}`);
      },
      request: async (method, params, streamId) => {
        if (method === "load_workspace") return copy(workspace);
        if (method === "load_memory") return structuredClone({ memories: workspace.memories, memoryOverview: workspace.memoryOverview });
        if (method === "get_runtime_catalog") return { nonProductivityProfiles: [], productivityProviders: [
          { id: "codex", label: "Codex", models: ["test"], defaultModel: "test", efforts: ["low"] }],
          defaultProductivityProvider: "codex", defaultNonProductivityProfile: "" };
        if (method === "get_productivity_models") return { provider: "codex", models: [], efforts: [] };
        if (method === "get_pending_questions" || method === "get_local_skills") return [];
        if (method === "load_timeline") {
          const thread = workspace.threads.find((item) => item.id === params.thread_id);
          return copy({ items: thread.items, total: thread.items.length, hasBefore: false, hasAfter: false, before: null, after: null });
        }
        if (method === "load_thread") return copy(workspace.threads.find((thread) => thread.id === params.thread_id));
        if (method === "open_evolution_thread") {
          window.isolation.calls.push("open");
          if (options.has("hold-open")) await new Promise((done) => { releaseOpen = done; });
          if (!workspace.threads.includes(evo)) workspace.threads.unshift(evo);
          return copy({ thread: evo, workspace });
        }
        if (method === "stream_turn") {
          const thread = params.thread_id === evo.id ? evo : dev;
          thread.items.push(message(`${thread.id}-user`, params.prompt, "user"));
          await new Promise((done) => streams.set(thread.id, { id: streamId, done }));
          return;
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    };
  }, { fixture: snapshot });
  const navigate = (name) => page.getByRole("navigation", { name: "工作区" }).getByRole("button", { name, exact: true }).click();
  const content = () => page.getByTestId("conversation").innerText();
  const visible = (text) => page.getByTestId("conversation").getByText(text, { exact: true }).waitFor();
  const send = async (text) => { await page.getByTestId("composer-input").fill(text); await page.getByTestId("composer-input").press("Enter"); };
  const stream = (id) => page.waitForFunction((value) => window.isolation.streams.has(value), id);
  const check = async (name, query, action) => {
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/?${query}`,
        { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.getByTestId("composer-input").waitFor();
      await action();
      assert.deepEqual(errors, []);
      console.log(`PASS ${name}`);
    } catch (error) { failures.push(`${name}: ${error.message}`); console.error(`FAIL ${name}: ${error.message}`); }
  };
  await check("return during evolution streaming restores history and subsequent chunks", "", async () => {
    await visible("DEV HISTORY"); await navigate("进化"); await visible("EVOLUTION HISTORY");
    await send("change evolution"); await stream("evolution");
    await navigate("开发"); await visible("DEV HISTORY");
    await page.evaluate(() => window.isolation.chunk("evolution", "EVOLUTION OUTPUT"));
    assert.ok(!(await content()).includes("EVOLUTION OUTPUT"));
    await navigate("进化"); await visible("EVOLUTION HISTORY"); await visible("EVOLUTION OUTPUT");
    await page.evaluate(() => { window.isolation.chunk("evolution", "EVOLUTION COMPLETE"); window.isolation.finish("evolution"); });
    await visible("EVOLUTION COMPLETE");
    for (let i = 0; i < 3; i++) { await navigate("开发"); await visible("DEV HISTORY"); await navigate("进化"); await visible("EVOLUTION COMPLETE"); }
    assert.equal(await page.getByText("EVOLUTION COMPLETE", { exact: true }).count(), 1);
  });
  await check("background refresh cannot select evolution in development", "", async () => {
    await navigate("进化"); await visible("EVOLUTION HISTORY"); await send("change"); await stream("evolution");
    await navigate("开发"); await visible("DEV HISTORY");
    await page.evaluate(() => { window.isolation.chunk("evolution", "EVOLUTION ONLY"); window.isolation.refresh("evolution"); window.isolation.finish("evolution"); });
    await page.waitForFunction(() => window.isolation.listening() === 0);
    await visible("DEV HISTORY"); assert.ok(!(await content()).includes("EVOLUTION ONLY"));
  });
  await check("late creation and preparation keep development selection and cache the new thread", "new&hold-open&hold-prepare", async () => {
    await navigate("进化"); await send("create feature");
    await page.waitForFunction(() => window.isolation.calls.includes("open"));
    await navigate("开发");
    await page.getByTestId("thread-list").getByRole("button", { name: /^development-two/ }).click();
    await visible("DEV OTHER HISTORY");
    await page.getByTestId("composer-input").fill("DEV UNSENT DRAFT");
    await page.evaluate(() => window.isolation.releaseOpen());
    await page.waitForFunction(() => window.isolation.calls.includes("prepare"));
    await page.evaluate(() => window.isolation.releasePrepare()); await stream("evolution");
    await page.evaluate(() => { window.isolation.chunk("evolution", "NEW EVOLUTION OUTPUT"); window.isolation.finish("evolution"); });
    await page.waitForFunction(() => window.isolation.listening() === 0);
    await visible("DEV OTHER HISTORY"); assert.equal(await page.getByTestId("composer-input").inputValue(), "DEV UNSENT DRAFT");
    await navigate("进化"); await visible("NEW EVOLUTION OUTPUT");
    assert.ok(!(await content()).includes("DEV HISTORY"));
    await navigate("开发"); await visible("DEV OTHER HISTORY");
    assert.equal(await page.getByTestId("composer-input").inputValue(), "DEV UNSENT DRAFT");
  });
  await check("development output stays in development while evolution is open", "", async () => {
    await send("DEV REQUEST"); await stream("development"); await navigate("进化");
    await visible("EVOLUTION HISTORY");
    await page.evaluate(() => { window.isolation.chunk("development", "DEV OUTPUT"); window.isolation.finish("development"); });
    assert.ok(!(await content()).includes("DEV OUTPUT"));
    await navigate("开发"); await visible("DEV OUTPUT");
  });
  await check("return before delayed creation completes still selects its eventual thread", "new&hold-open", async () => {
    await navigate("进化"); await send("create feature");
    await page.waitForFunction(() => window.isolation.calls.includes("open"));
    await navigate("开发"); await visible("DEV HISTORY"); await navigate("进化");
    await page.evaluate(() => window.isolation.releaseOpen()); await stream("evolution");
    await page.evaluate(() => { window.isolation.chunk("evolution", "LATE CREATED OUTPUT"); window.isolation.finish("evolution"); });
    await visible("LATE CREATED OUTPUT");
  });
  await check("startup selection excludes an evolution thread in the shared backend snapshot", "last-evolution", async () => {
    await visible("DEV HISTORY"); assert.ok(!(await content()).includes("EVOLUTION HISTORY"));
  });
  await check("development with no ordinary projects never falls back to evolution", "only-evolution", async () => {
    assert.ok(!(await content()).includes("EVOLUTION HISTORY"));
    await navigate("进化"); await visible("EVOLUTION HISTORY"); await navigate("开发");
    assert.ok(!(await content()).includes("EVOLUTION HISTORY"));
    await send("DEV REQUEST WITHOUT PROJECT");
    await page.getByText("请先打开一个工作目录。", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.isolation.streams.size), 0);
  });
  assert.deepEqual(failures, [], failures.join("\n"));
} finally {
  await app?.close();
  await new Promise((done) => server.close(done));
  assert.equal(dirname(root), resolve(tmpdir()));
  await rm(root, { recursive: true, force: true });
}
