import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshot } from "../src/services/mockData.ts";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "cleo-history-smoke-"));
const appDir = join(scratch, "app");
let application;
try {
  await mkdir(appDir);
  await cp(join(ui, "electron"), join(appDir, "electron"), { recursive: true });
  await cp(join(ui, "package.json"), join(appDir, "package.json"));
  const build = spawnSync(process.execPath, [join(ui, "node_modules/vite/bin/vite.js"), "build", "--outDir", join(appDir, "dist")], { cwd: ui, stdio: "pipe", windowsHide: true });
  assert.equal(build.status, 0, build.stderr?.toString());
  if (!process.argv.includes("--regression-only")) {
  application = await electron.launch({ args: [appDir, `--user-data-dir=${join(scratch, "profile")}`],
    env: { ...process.env, CLEO_DESKTOP_MOCK: "1", CLEO_HOME: join(scratch, "home") } });
  const page = await application.firstWindow();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await application.context().addInitScript(({ snapshot }) => {
    const rows = Array.from({ length: 10000 }, (_, i) => ({ id: `m-${i}`, turnId: `m-${i - i % 2}`, turnHasAnswer: true,
      type: "message", role: i % 2 ? "assistant" : "user", content: `History item ${i}`, time: "12:00", cursor: String(i) }));
    // One turn of this session holds 502 tool records between its question and its reply: folded they
    // are one line, but they fill the 500-item cache on their own.
    const roles = { 1: "user", 4: "assistant", 5: "user", 53: "assistant", 54: "user", 74: "assistant", 75: "user",
      578: "assistant", 579: "user", 584: "assistant", 585: "user", 623: "assistant" };
    let turn = "";
    const work = Array.from({ length: 623 }, (_, i) => {
      const id = `w-${i + 1}`;
      if (roles[i + 1] === "user") turn = id;
      return roles[i + 1]
        ? { id, turnId: turn, turnHasAnswer: true, type: "message", role: roles[i + 1], content: `Work message ${i + 1}`, time: "12:00" }
        : { id, turnId: turn, turnHasAnswer: true, type: "tool", name: "test", command: `step ${i + 1}`, status: "done" };
    });
    const session = (prefix, title, length, userAt, output) => Array.from({ length }, (_, i) => {
      const id = `${prefix}-${i + 1}`;
      const user = userAt(i);
      if (user) turn = id;
      return user === undefined
        ? { id, turnId: turn, turnHasAnswer: true, type: "tool", name: "test", command: `step ${i + 1}`, status: "done", ...(output ? { output } : {}) }
        : { id, turnId: turn, turnHasAnswer: true, type: "message", role: user ? "user" : "assistant", content: `${title} message ${i + 1}`, time: "12:00" };
    });
    // Ten ordinary turns, then one whose 200 tool calls carry 30 KB of output each, then two short
    // turns: the cache is full at 4 MiB with some sixty of the calls, and a page of them ends at
    // 512 KiB like the backend's.
    const heavy = session("h", "Heavy", 225, i => i < 21 || i > 220 ? i % 2 === 0 : undefined, "x".repeat(30000));
    // Fifty turns of two messages, a long turn that ends in its reply, and a last turn of tool calls.
    // One page ends on that turn's question; the final page takes twenty messages off the top of a
    // full window and adds two lines below.
    const tail = session("t", "Tail", 600, i => i < 101 ? i % 2 === 0 : i === 579 ? true : i === 578 || i === 599 ? false : undefined);
    const storage = { history: rows, questions: [], work, heavy, tail };
    const runtime = { provider: "codex", model: "test", effort: "low", serviceTier: "default", supportsFastMode: true, access: "workspace-write", approval: "user", contextWindow: 128000, editable: true };
    const titles = { history: "万条历史", questions: "交互提问", work: "长工具组", heavy: "长输出", tail: "收尾" };
    const threads = Object.keys(titles).map(id => ({ id, space: "productivity", projectId: "p", title: titles[id], status: "idle", summary: "", updatedAt: "", items: [], changes: [], usage: {}, runtime }));
    // As cleo/desktop/timeline.py: at most 80 items and 512 KiB, counted from the cursor outwards.
    const weights = {};
    const pageOf = (id, direction = "latest", cursor) => {
      const all = storage[id];
      const weight = weights[id] ??= [];
      const weigh = index => weight[index] ??= JSON.stringify(all[index]).length;
      const fits = (index, count, size) => count < 80 && (!count || size + weigh(index) <= 512 * 1024);
      const pivot = Number(cursor);
      let start = direction === "after" ? pivot + 1 : direction === "before" ? pivot : all.length;
      let end = start;
      if (direction === "after") for (let size = 0; end < all.length && fits(end, end - start, size); end++) size += weigh(end);
      else for (let size = 0; start > 0 && fits(start - 1, end - start, size); start--) size += weigh(start - 1);
      return { items: all.slice(start, end).map((item, i) => ({ ...item, cursor: String(start + i) })), total: all.length,
        before: String(start), after: String(end - 1), hasBefore: start > 0, hasAfter: end < all.length, revision: String(all.length) };
    };
    const load = id => { const { items, ...history } = pageOf(id); return { ...threads.find(t => t.id === id), items, history }; };
    const listeners = new Set();
    let stream;
    let finish;
    const pending = new Map();
    window.historyRequests = [];
    window.answers = [];
    window.failHistory = false;
    window.failAnswer = false;
    window.emitTest = event => {
      if (event.type === "upsert-item") {
        const all = storage[stream.threadId];
        const index = all.findIndex(i => i.id === event.item.id);
        if (index < 0) all.push(event.item); else all[index] = event.item;
      }
      for (const listener of listeners) listener({ streamId: stream.id, event });
    };
    window.finishTurn = () => finish?.();
    window.askTest = provider => {
      const request = { id: `question-${pending.size}-${Date.now()}`, threadId: stream.threadId, provider, status: "pending", questions: [
        { id: "choice", header: "方向", question: "选择实现方式", multiple: false, options: [{ label: "A", description: "方式 A" }, { label: "B", description: "方式 B" }] },
        { id: "multiple", header: "范围", question: "选择范围", multiple: provider === "claude", options: [{ label: "前端", description: "界面" }, { label: "后端", description: "服务" }] },
        { id: "text", header: "说明", question: "补充说明", multiple: false, options: [] },
      ] };
      pending.set(request.id, request);
      storage[stream.threadId].push({ id: request.id, turnId: "live-turn", type: "question", request });
      window.emitTest({ type: "question-request", request });
    };
    window.cleoDesktop = {
      async request(method, params = {}, streamId) {
        if (method === "load_workspace") return { ...snapshot, projects: [{ id: "p", name: "Test", path: "fixture", space: "productivity", accent: "cyan" }], threads: [load("history"), ...threads.slice(1)], activeThreadId: "history", activeSpace: "productivity", runtime };
        if (method === "load_memory") return structuredClone({ memories: snapshot.memories, memoryOverview: snapshot.memoryOverview });
        if (method === "get_runtime_catalog") return { nonProductivityProfiles: [], defaultNonProductivityProfile: "", defaultProductivityProvider: "codex", productivityProviders: [{ id: "codex", type: "codex_sdk", defaultModel: "test", modelSource: "config" }] };
        if (method === "get_productivity_models") return { provider: "codex", source: "sdk", models: [{ id: "test", label: "test", isDefault: true, defaultEffort: "low", supportedEfforts: ["low"] }] };
        if (method === "load_thread") return load(params.thread_id);
        if (method === "update_runtime") {
          const thread = threads.find(t => t.id === params.thread_id);
          thread.runtime = { ...thread.runtime, ...params.update };
          return thread.runtime;
        }
        if (method === "load_timeline") {
          window.historyRequests.push(params);
          if (window.failHistory) { window.failHistory = false; throw new Error("模拟历史加载失败"); }
          if (window.delayHistory) { window.delayHistory = false; await new Promise(resolve => setTimeout(resolve, 200)); }
          if (window.holdHistory) { window.holdHistory = false; await new Promise(resolve => { window.releaseHistory = resolve; }); }
          return pageOf(params.thread_id, params.direction, params.cursor);
        }
        if (method === "get_pending_questions") return [...pending.values()].filter(q => q.threadId === params.thread_id);
        if (method === "stream_turn") {
          stream = { id: streamId, threadId: params.thread_id };
          if (window.holdTurnStart) await new Promise(resolve => { window.releaseTurnStart = resolve; });
          const turnId = params.prompt.startsWith("Send from ") ? params.prompt : "live-turn";
          const user = { id: turnId, turnId, type: "message", role: "user", content: params.prompt, time: "" };
          storage[params.thread_id].push(user);
          window.emitTest({ type: "turn-started", item: user });
          await new Promise(resolve => { finish = resolve; });
          return;
        }
        if (method === "resolve_question") {
          if (window.failAnswer) { window.failAnswer = false; throw new Error("模拟提交失败"); }
          const request = pending.get(params.question_id);
          if (!request || request.threadId !== params.thread_id) throw new Error("问题已失效");
          window.answers.push(params);
          request.answers = params.answers; request.status = "answered";
          pending.delete(request.id);
          window.emitTest({ type: "question-resolved", request });
          return;
        }
        if (method === "cancel_run") {
          for (const request of pending.values()) { request.status = "cancelled"; window.emitTest({ type: "question-resolved", request }); }
          pending.clear(); finish?.(); return;
        }
        throw new Error(`Unhandled test method: ${method}`);
      },
      onStreamEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      getUpdateState: async () => ({ phase: "unsupported", currentVersion: "test" }),
      onUpdateState: () => () => {}, confirmHealthy: async () => {}, setTheme: () => {},
    };
  }, { snapshot });
  await page.reload();
  await page.getByText("History item 9999", { exact: true }).waitFor();
  assert.equal(await page.locator(".history-page-control").count(), 0, "History paging should be automatic");
  const inspector = page.getByTestId("inspector");
  if (await inspector.count()) await inspector.getByRole("button", { name: "关闭检查器", exact: true }).click();
  const viewport = page.locator(".conversation-viewport");
  // Speed is the switch in the effort chip's menu; the model chip reports the current value.
  const pill = page.getByTestId("runtime-selector");
  const effortChip = page.getByTestId("effort-selector");
  const setSpeed = async value => {
    await effortChip.click();
    await page.getByTestId("speed-toggle").setChecked(value === "fast");
    await page.keyboard.press("Escape");
    await page.getByTestId("effort-menu").waitFor({ state: "detached" });
  };
  assert.equal(await pill.getAttribute("data-speed"), "default");
  await setSpeed("fast");
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-selector"]').dataset.speed === "fast");
  await page.getByText("交互提问", { exact: true }).click();
  assert.equal(await pill.getAttribute("data-speed"), "default", "Fast mode leaked into another task");
  await page.getByText("万条历史", { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-selector"]').dataset.speed === "fast");
  await setSpeed("default");
  await page.waitForFunction(() => document.querySelector('[data-testid="runtime-selector"]').dataset.speed === "default");
  // Scrolling one way must only ever page that way (#202). With the long turn folded, the window
  // around it is a few lines: both of its edges are within reach of the view at once, and the
  // cache cannot hold the messages on both sides of the turn together.
  const cache = name => page.getByTestId("conversation").getAttribute(`data-cache-${name}`);
  const settle = () => page.evaluate(async () => {
    for (let frame = 0; frame < 3 || (frame < 300 && document.querySelector(".history-loading")); frame++) await new Promise(resolve => requestAnimationFrame(resolve));
  });
  /** `stray`: a tick the other way first, as a trackpad or a wheel coming to rest sends them. */
  const wheel = async (delta, stray = 0) => {
    await viewport.hover();
    if (stray) await page.mouse.wheel(0, -Math.sign(delta) * stray);
    await page.mouse.wheel(0, delta);
    await settle();
  };
  /** Record, frame by frame, the loaded window, the messages in view (ids start with `prefix`) and
   * how far the view is from both ends, so one frame out of place is caught. */
  const trace = (prefix = "w-") => page.evaluate(prefix => {
    window.historyRequests.length = 0;
    window.frames = [];
    cancelAnimationFrame(window.traceFrame);
    const sample = () => {
      const shell = document.querySelector("[data-cache-first]");
      const viewport = document.querySelector(".conversation-viewport");
      const view = viewport.getBoundingClientRect();
      const number = id => Number(id.slice(id.lastIndexOf("-") + 1));
      const rows = [...document.querySelectorAll(`[data-row-id^="${prefix}"]`)].map(row => ({ id: number(row.dataset.rowId), rect: row.getBoundingClientRect() }))
        .filter(row => row.rect.bottom > view.top + 1 && row.rect.top < view.bottom - 1);
      window.frames.push({ first: number(shell.dataset.cacheFirst), last: number(shell.dataset.cacheLast), shown: rows.map(row => row.id),
        spans: rows.map(row => [row.rect.top - view.top, row.rect.bottom - view.top]), height: view.height,
        toStart: viewport.scrollTop, toEnd: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop });
      window.traceFrame = requestAnimationFrame(sample);
    };
    sample();
  }, prefix);
  const traced = () => page.evaluate(() => { cancelAnimationFrame(window.traceFrame); return { frames: window.frames, requests: window.historyRequests.map(request => request.direction) }; });
  /** Heading one way, no frame may show the window, or the message at the leading edge of the view,
   * further back than an earlier frame did; no page is asked for behind the reader; and every
   * message passes through the view, none skipped. */
  const oneWay = ({ frames, requests }, down, label, messages = [1, 4, 5, 53, 54, 74, 75, 578, 579, 584, 585, 623]) => {
    const said = `${label} (${requests.join(" → ")})`;
    assert(!requests.includes(down ? "before" : "after"), `${said}: a page was loaded behind the reader`);
    const back = (now, then) => down ? now < then : now > then;
    let edge = frames[0][down ? "first" : "last"];
    let lead = null;
    for (const frame of frames) {
      const at = frame[down ? "first" : "last"];
      assert(!back(at, edge), `${said}: the window went back from w-${edge} to w-${at}`);
      edge = at;
      if (!frame.shown.length) continue;
      const leading = down ? frame.shown[0] : frame.shown.at(-1);
      assert(lead === null || !back(leading, lead), `${said}: w-${leading} came back into view after w-${lead}`);
      lead = leading;
    }
    const seen = new Set(frames.flatMap(frame => frame.shown));
    assert.deepEqual(messages.filter(message => !seen.has(message)), [], `${said}: messages never came into view`);
  };
  /** A page takes a message that is still well in view out of the window only under a reader who
   * stands at the edge it is loaded at. */
  const givesWayAtEdge = ({ frames }, down, label) => frames.slice(1).forEach((frame, index) => {
    const before = frames[index];
    if (before.first === frame.first && before.last === frame.last) return;
    before.shown.forEach((message, row) => {
      const [top, bottom] = before.spans[row];
      if (frame.shown.includes(message) || (down ? bottom < 100 : top > before.height - 100)) return;
      const toEdge = down ? before.toEnd : before.toStart;
      assert(toEdge <= 1, `${label}: message ${message} left the view when a page arrived, ${Math.round(toEdge)}px before the reader reached the edge`);
    });
  });
  const place = id => page.evaluate(id => {
    const row = document.querySelector(`[data-row-id="${id}"]`);
    return row ? row.getBoundingClientRect().top - document.querySelector(".conversation-viewport").getBoundingClientRect().top : null;
  }, id);
  await page.getByText("长工具组", { exact: true }).click();
  await page.getByText("Work message 623", { exact: true }).waitFor();
  await settle();
  // What the page takes up besides its rows, and the height of a folded turn: enough to size the
  // two messages after the long turn so that the four-line window is a chosen height.
  const folds = page.locator('[data-row-id]:has([data-testid="work-group"])');
  const longTurn = await folds.first().getAttribute("data-row-id");
  const layout = await page.evaluate(() => {
    const view = document.querySelector(".conversation-viewport");
    const heights = [...document.querySelectorAll("[data-row-id]")].map(row => row.getBoundingClientRect().height);
    return { view: view.clientHeight, chrome: view.scrollHeight - heights.reduce((sum, height) => sum + height, 0),
      fold: document.querySelector('[data-row-id]:has([data-testid="work-group"])').getBoundingClientRect().height };
  });
  const windowHeight = async overflow => {
    await page.evaluate(height => {
      const style = document.getElementById("work-heights") ?? document.head.appendChild(Object.assign(document.createElement("style"), { id: "work-heights" }));
      style.textContent = `[data-row-id="w-578"], [data-row-id="w-579"] { min-height: ${height}px; }`;
    }, (layout.view + overflow - layout.chrome - 2 * layout.fold) / 2);
    // The view follows the end of the resized rows before anything is measured against it.
    await page.waitForFunction(() => {
      const view = document.querySelector(".conversation-viewport");
      return view.scrollHeight - view.clientHeight - view.scrollTop < 2;
    });
    await settle();
  };
  const toTop = async (label, { stray = 0, first = "w-1", text = "Work message 1" } = {}) => {
    for (let step = 0; step < 200 && (await cache("first") !== first || await viewport.evaluate(view => view.scrollTop > 0)); step++) await wheel(-120, stray);
    assert.equal(await cache("first"), first, `${label}: scrolling up did not reach the first message`);
    assert(await page.getByText(text, { exact: true }).isVisible());
  };
  const toLatest = async (label, { stray = 0, last = "w-623", text = "Work message 623" } = {}) => {
    for (let step = 0; step < 200 && (await cache("last") !== last || await page.locator(".history-latest").count()); step++) await wheel(120, stray);
    assert.equal(await cache("last"), last, `${label}: scrolling down did not reach the newest message`);
    assert.equal(await page.locator(".history-latest").count(), 0, `${label}: the view did not arrive at the end`);
    assert(await page.getByText(text, { exact: true }).isVisible());
  };
  // The four-line window a little taller than the view, and exactly as tall as it. Then once more
  // with a small tick the wrong way before every step: it is no turn, and loads nothing behind.
  for (const [overflow, stray] of [[35, 0], [0, 0], [35, 2]]) {
    const label = `${overflow ? "a window slightly taller than the view" : "a window exactly as tall as the view"}${stray ? ", with stray ticks" : ""}`;
    await windowHeight(overflow);
    await trace();
    await toTop(label, { stray });
    oneWay(await traced(), false, `${label}, up`);
    await trace();
    await toLatest(label, { stray });
    const down = await traced();
    assert(down.frames.some(frame => frame.first === 81 && frame.last === 580), `${label}: the long turn never filled the window`);
    oneWay(down, true, `${label}, down`);
    assert.equal(await folds.first().getAttribute("data-row-id"), longTurn, `${label}: the long turn became another row on the way`);
  }
  // With its messages cut short, the first window does not scroll. An arrow key asks for the next
  // page there like the wheel does, although nothing moves.
  await windowHeight(35);
  await toTop("a key at the edge");
  const short = await page.evaluateHandle(() => Object.assign(document.head.appendChild(document.createElement("style")),
    { textContent: `[data-row-id^="w-"] { max-height: 24px; overflow: hidden; }` }));
  await settle();
  assert(await viewport.evaluate(view => view.scrollHeight <= view.clientHeight), "The shortened first window should fit the view");
  assert.equal(await cache("first"), "w-1");
  await viewport.focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => document.querySelector("[data-cache-first]").dataset.cacheFirst !== "w-1", null, { timeout: 5000 })
    .catch(() => assert.fail("An arrow key at the end of a window too short to scroll did not load the next page"));
  await short.evaluate(style => style.remove());
  await settle();
  // A page asked for at an edge arrives after the reader has turned and left that edge. It would
  // take the lines they are on now out of the window, so it is dropped: window and view stay.
  await toTop("a late page");
  for (let step = 0; step < 200 && await cache("first") !== "w-81"; step++) await wheel(120);
  await settle();
  await page.evaluate(() => { window.holdHistory = true; });
  for (let step = 0; step < 5 && !await page.evaluate(() => Boolean(window.releaseHistory)); step++) {
    await viewport.hover();
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(300);
  }
  assert(await page.evaluate(() => Boolean(window.releaseHistory)), "Turning round at the top edge did not ask for the page behind");
  await viewport.hover();
  await page.mouse.wheel(0, 120);
  await page.waitForFunction(() => document.querySelector(".conversation-viewport").scrollTop > 10);
  await page.waitForTimeout(300);
  const late = { first: await cache("first"), top: await place("w-578") };
  await page.evaluate(() => { window.releaseHistory(); window.releaseHistory = null; });
  await settle();
  await page.waitForTimeout(100);
  assert.equal(await cache("first"), late.first, "A page that arrived after the reader had left its edge replaced what they were reading");
  assert(Math.abs(await place("w-578") - late.top) <= 2, `A page that arrived late moved the reader's message from ${late.top} to ${await place("w-578")}`);
  // Turning round takes effect with the first input: in the four-line window the earlier messages
  // come back, and heading down again still arrives at the end. The long turn, opened, stays open.
  await windowHeight(35);
  await toTop("turning round");
  await folds.last().getByRole("button").click();
  for (let step = 0; step < 200 && await cache("first") !== "w-81"; step++) await wheel(120);
  assert.equal(await cache("first"), "w-81");
  assert(!await page.getByText("Work message 75", { exact: true }).isVisible());
  await trace();
  for (let step = 0; step < 20 && !await page.getByText("Work message 75", { exact: true }).isVisible(); step++) await wheel(-120);
  const turned = await traced();
  assert.equal(turned.requests[0], "before", `turning round did not load the page behind (${turned.requests.join(" → ")})`);
  assert.equal(await cache("first"), "w-1");
  assert(await page.getByText("Work message 75", { exact: true }).isVisible(), "the messages before the long turn did not come back");
  await toLatest("turning round");
  assert.equal(await page.locator(`[data-row-id="${longTurn}"]`).getByRole("button").getAttribute("aria-expanded"), "true", "the opened long turn closed while the window moved over it");
  await page.locator(`[data-row-id="${longTurn}"]`).getByRole("button").click();
  await page.evaluate(() => {
    document.head.appendChild(document.createElement("style")).textContent = `[data-row-id^="h-"], [data-row-id^="t-"] { min-height: 240px; } [data-row-id="t-579"] { min-height: 2400px; }`;
  });
  // Tool calls with long output fill the cache by weight: sixty of them, not five hundred, and a
  // page of them pushes every message before the turn out at once. Those messages stay until the
  // reader stands at the edge, and both ways through the turn arrive.
  await page.getByText("长输出", { exact: true }).click();
  await page.getByText("Heavy message 225", { exact: true }).waitFor();
  await settle();
  const heavyMessages = [...Array.from({ length: 21 }, (_, i) => i + 1), 222, 223, 224, 225];
  await trace("h-");
  await toTop("long output", { first: "h-1", text: "Heavy message 1" });
  const heavyUp = await traced();
  oneWay(heavyUp, false, "long output, up", heavyMessages);
  givesWayAtEdge(heavyUp, false, "long output, up");
  await trace("h-");
  await toLatest("long output", { last: "h-225", text: "Heavy message 225" });
  const heavyDown = await traced();
  oneWay(heavyDown, true, "long output, down", heavyMessages);
  givesWayAtEdge(heavyDown, true, "long output, down");
  // A page ahead of the reader ends on a user message. It is not one they just sent: the view
  // stays on what they are reading instead of moving that message to the top.
  await page.getByText("收尾", { exact: true }).click();
  await page.getByText("Tail message 600", { exact: true }).waitFor();
  await settle();
  for (let step = 0; step < 40 && await cache("first") !== "t-1"; step++) await wheel(-10000000);
  assert.equal(await cache("last"), "t-500");
  /** Put the view 300px above the end of the window, where the next page is asked for, and hold that page. */
  const nearEnd = async () => {
    await page.evaluate(() => {
      window.holdHistory = true;
      const view = document.querySelector(".conversation-viewport");
      view.scrollTop = view.scrollHeight - view.clientHeight - 300;
    });
    await page.waitForFunction(() => window.releaseHistory);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const arrived = async last => {
    await page.waitForFunction(last => document.querySelector("[data-cache-last]").dataset.cacheLast === last, last);
    await page.waitForTimeout(500);
    await settle();
  };
  await nearEnd();
  const question = await place("t-100");
  await page.evaluate(() => { window.releaseHistory(); window.releaseHistory = null; });
  await arrived("t-580");
  assert(Math.abs(await place("t-100") - question) <= 2, `A page that ends on a user message moved the reader from ${question} to ${await place("t-100")}, as if they had just sent it`);
  // The last page arrives while the reader's latest move has not reached the timeline yet, and it
  // takes far more off the top than it adds below. The reader is in the middle of a long reply:
  // they stay there, and are not taken for someone who has arrived at the newest message.
  await nearEnd();
  const reply = await place("t-579");
  await page.evaluate(() => {
    // The timeline hears of a scroll in the next frame. That frame is put off until the page is in.
    const frame = window.requestAnimationFrame;
    window.requestAnimationFrame = callback => setTimeout(() => frame(callback), 200);
    setTimeout(() => { window.requestAnimationFrame = frame; }, 400);
    document.querySelector(".conversation-viewport").scrollTop += 30;
    window.releaseHistory(); window.releaseHistory = null;
  });
  await arrived("t-600");
  assert(Math.abs(await place("t-579") - (reply - 30)) <= 2, `The last page moved the reader's reply from ${reply} to ${await place("t-579")}`);
  assert(await page.locator(".history-latest").count(), "The last page pinned a reader in the middle of a reply to the newest message");
  await page.getByText("万条历史", { exact: true }).click();
  await page.getByText("History item 9999", { exact: true }).waitFor();
  // A page of earlier history arrives under a reader at the top edge: the message they were on
  // stays where it was, also when they scrolled against the edge again in the meantime (the input
  // moved nothing), and a scroll the other way moves it by just that much.
  for (const [delta, moved] of [[0, 0], [-40, 0], [40, -40]]) {
    await page.evaluate(() => { window.holdHistory = true; });
    await viewport.hover();
    await page.mouse.wheel(0, -10000000);
    await page.waitForFunction(() => window.releaseHistory && document.querySelector(".conversation-viewport").scrollTop === 0);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const held = await page.evaluate(() => {
      const row = document.querySelector('[data-row-id="m-9920"]');
      return row.getBoundingClientRect().top - document.querySelector(".conversation-viewport").getBoundingClientRect().top;
    });
    // With input, the page is let through as the input reaches the window, after the timeline has seen it.
    if (delta) {
      await page.evaluate(() => window.addEventListener("wheel", () => { window.releaseHistory(); window.releaseHistory = null; }, { once: true }));
      await viewport.hover();
      await page.mouse.wheel(0, delta);
    } else await page.evaluate(() => { window.releaseHistory(); window.releaseHistory = null; });
    await page.waitForFunction(() => document.querySelector("[data-cache-first]").dataset.cacheFirst === "m-9840");
    await settle();
    const now = await page.evaluate(() => {
      const row = document.querySelector('[data-row-id="m-9920"]');
      return row ? row.getBoundingClientRect().top - document.querySelector(".conversation-viewport").getBoundingClientRect().top : null;
    });
    assert(now !== null && Math.abs(now - held - moved) <= 2, `Earlier history moved the reader's message from ${held} to ${now} (wheel ${delta})`);
    await page.getByRole("button", { name: "回到最新", exact: true }).click();
    await page.getByRole("button", { name: "回到最新", exact: true }).waitFor({ state: "hidden" });
    await page.getByText("History item 9999", { exact: true }).waitFor();
  }
  // Small upward wheel movements must escape bottom-follow, including repeated
  // touchpad-sized deltas. Scrolling back to the bottom must restore following.
  for (const delta of [20, 40, 80]) {
    await viewport.hover();
    await page.mouse.wheel(0, -delta);
    await page.waitForTimeout(150);
    assert(await viewport.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop > 10),
      `Upward ${delta}px wheel movement was pulled back to the bottom`);
    await page.getByRole("button", { name: "回到最新", exact: true }).click();
    await page.getByRole("button", { name: "回到最新", exact: true }).waitFor({ state: "hidden" });
  }
  for (let i = 0; i < 6; i++) {
    await viewport.hover();
    await page.mouse.wheel(0, -40);
    await page.waitForTimeout(100);
  }
  assert(await viewport.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop > 180),
    "Repeated small upward movements did not advance through history");
  await page.mouse.wheel(0, 600);
  await page.getByRole("button", { name: "回到最新", exact: true }).waitFor({ state: "hidden" });
  assert(await viewport.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop < 2),
    "Scrolling back to the bottom did not restore following");
  // Deliver wheel intent before the compositor's scroll position, then cause an
  // unrelated React render before the native scroll event reaches the timeline.
  for (const frames of [1, 4]) {
    const before = await page.getByTestId("conversation").getAttribute("data-cache-first");
    await viewport.evaluate(async (element, frames) => {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -10000000, bubbles: true }));
      for (let frame = 0; frame < frames; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
      element.scrollTop = 0;
      const input = document.querySelector('[data-testid="composer-input"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, `Scroll regression ${frames}`);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, frames);
    await page.waitForFunction(old => document.querySelector("[data-cache-first]")?.getAttribute("data-cache-first") !== old, before);
    await page.waitForFunction(() => {
      const view = document.querySelector(".conversation-viewport");
      return view.scrollHeight - view.clientHeight - view.scrollTop > 96 && document.querySelector(".history-latest");
    });
    assert(await page.evaluate(() => window.historyRequests.some(request => request.direction === "before")),
      "Delayed native scrolling did not load earlier history");
    assert.equal(await page.getByTestId("composer-input").inputValue(), `Scroll regression ${frames}`);
    await page.getByRole("button", { name: "回到最新", exact: true }).click();
    await page.getByRole("button", { name: "回到最新", exact: true }).waitFor({ state: "hidden" });
    await page.getByText("History item 9999", { exact: true }).waitFor();
  }
  await page.getByTestId("composer-input").fill("");
  await viewport.hover(); await page.mouse.wheel(0, -600);
  await page.waitForFunction(() => document.querySelector(".history-latest"));
  const anchored = await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const top = document.querySelector(".conversation-viewport").getBoundingClientRect().top;
    const nodes = [...document.querySelectorAll("[data-row-id]")];
    const index = nodes.findIndex(node => node.getBoundingClientRect().bottom > top + 1);
    const anchor = nodes[index];
    const original = { id: anchor.dataset.rowId, top: anchor.getBoundingClientRect().top - top };
    if (index > 0) {
      const image = document.createElement("img"); image.alt = "Delayed image";
      image.style.cssText = "display:block;width:120px;height:160px";
      nodes[index - 1].append(image);
    }
    return original;
  });
  await page.waitForFunction(({ id, top }) => {
    const row = document.querySelector(`[data-row-id="${id}"]`);
    return row && Math.abs(row.getBoundingClientRect().top - document.querySelector(".conversation-viewport").getBoundingClientRect().top - top) < 3;
  }, anchored);
  await page.getByRole("button", { name: "回到最新", exact: true }).click();
  await page.getByRole("button", { name: "回到最新", exact: true }).waitFor({ state: "hidden" });
  await page.getByText("History item 9999", { exact: true }).waitFor();
  for (let i = 0; i < 140; i++) {
    const before = await page.locator("[data-cache-first]").getAttribute("data-cache-first");
    if (before === "m-0") break;
    if (i === 8) await page.evaluate(() => { window.failHistory = true; });
    await viewport.hover();
    await page.mouse.wheel(0, -10000000);
    if (i === 8) {
      await page.getByText("模拟历史加载失败", { exact: false }).waitFor();
      await page.getByRole("button", { name: "重试加载" }).click();
    }
    await page.waitForFunction(old => document.querySelector("[data-cache-first]")?.getAttribute("data-cache-first") !== old, before, { timeout: 5000 }).catch(async error => {
      console.error(await page.evaluate(() => ({ first: document.querySelector("[data-cache-first]")?.getAttribute("data-cache-first"), scroll: document.querySelector(".conversation-viewport")?.scrollTop, requests: window.historyRequests.slice(-3), text: document.querySelector(".history-error")?.textContent })));
      throw error;
    });
    assert(Number(await page.getByTestId("conversation").getAttribute("data-cache-count")) <= 500);
    assert(await page.locator("[data-row-id]").count() < 60);
  }
  assert.equal(await page.getByTestId("conversation").getAttribute("data-cache-first"), "m-0");
  await viewport.hover();
  await page.mouse.wheel(0, -10000000);
  await page.getByText("History item 0", { exact: true }).waitFor();
  for (let i = 0; i < 5; i++) {
    const first = await page.getByTestId("conversation").getAttribute("data-cache-first");
    await viewport.hover(); await page.mouse.wheel(0, 10000000);
    await page.waitForFunction(old => document.querySelector("[data-cache-first]")?.getAttribute("data-cache-first") !== old, first);
  }
  await page.getByRole("button", { name: "回到最新", exact: true }).click();
  await page.getByRole("button", { name: "回到最新", exact: true }).waitFor({ state: "hidden" });
  await page.getByText("History item 9999", { exact: true }).waitFor();
  // Sending while reading history must show the optimistic user message before
  // the backend acknowledges it, then replace it without duplicates.
  for (const olderPage of [false, true]) {
    await viewport.hover();
    if (olderPage) {
      for (let i = 0; i < 7; i++) {
        const before = await page.getByTestId("conversation").getAttribute("data-cache-first");
        await page.mouse.wheel(0, -10000000);
        await page.waitForFunction(old => document.querySelector("[data-cache-first]")?.getAttribute("data-cache-first") !== old, before);
      }
    } else {
      await page.mouse.wheel(0, -40);
      await page.getByRole("button", { name: "回到最新", exact: true }).waitFor();
    }
    const prompt = `Send from ${olderPage ? "older page" : "near bottom"}`;
    await page.evaluate(() => { window.holdTurnStart = true; });
    await page.getByTestId("composer-input").fill(prompt);
    if (olderPage) {
      await page.evaluate(() => { window.failHistory = true; });
      await page.getByTestId("send-button").click();
      await page.getByText("无法加载最新对话，请重试发送。", { exact: true }).waitFor();
      assert.equal(await page.getByTestId("composer-input").inputValue(), prompt);
      assert.equal(await page.evaluate(() => Boolean(window.releaseTurnStart)), false,
        "Failed latest-page loading still started the turn");
    }
    await page.getByTestId("send-button").click();
    await page.waitForFunction(() => Boolean(window.releaseTurnStart));
    const message = page.getByRole("article", { name: "你的消息", exact: true }).getByText(prompt, { exact: true });
    await message.waitFor({ timeout: 3000 });
    assert(await message.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const viewport = document.querySelector(".conversation-viewport").getBoundingClientRect();
      return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
    }), "Sent user message is outside the visible history viewport");
    await page.evaluate(() => { window.releaseTurnStart(); window.releaseTurnStart = null; window.holdTurnStart = false; });
    await page.waitForFunction(id => [...document.querySelectorAll("[data-row-id]")].some(el => el.dataset.rowId === id), prompt);
    assert.equal(await message.count(), 1, "Turn acknowledgement duplicated the user message");
    await page.getByTestId("stop-button").click();
    await page.getByTestId("send-button").waitFor();
  }
  // A reply that finishes refreshes the newest page. A reader two pages back keeps that page and
  // their place in it.
  await page.getByTestId("composer-input").fill("Send from a turn that finishes");
  await page.getByTestId("send-button").click();
  await page.getByTestId("stop-button").waitFor();
  for (let pages = 0; pages < 2; pages++) {
    const first = await cache("first");
    await wheel(-10000000);
    await page.waitForFunction(old => document.querySelector("[data-cache-first]").dataset.cacheFirst !== old, first);
    await settle();
  }
  const reading = () => page.evaluate(() => {
    const top = document.querySelector(".conversation-viewport").getBoundingClientRect().top;
    const row = [...document.querySelectorAll("[data-row-id]")].find(node => node.getBoundingClientRect().bottom > top + 1);
    return { id: row.dataset.rowId, top: row.getBoundingClientRect().top - top, first: document.querySelector("[data-cache-first]").dataset.cacheFirst };
  });
  const read = await reading();
  await page.evaluate(() => { window.historyRequests.length = 0; window.finishTurn(); });
  await page.getByTestId("send-button").waitFor();
  await page.waitForFunction(() => window.historyRequests.some(request => request.direction === "latest"));
  await settle();
  const kept = await reading();
  assert.equal(kept.first, read.first, "A finished reply dropped the earlier pages the reader had opened");
  assert(kept.id === read.id && Math.abs(kept.top - read.top) <= 2, `A finished reply moved the reader from ${JSON.stringify(read)} to ${JSON.stringify(kept)}`);
  await page.getByRole("button", { name: "回到最新", exact: true }).click();
  await page.getByRole("button", { name: "回到最新", exact: true }).waitFor({ state: "hidden" });
  await page.evaluate(() => { window.delayHistory = true; });
  await viewport.hover(); await page.mouse.wheel(0, -10000000);
  await page.getByText("交互提问", { exact: true }).click();
  await page.waitForTimeout(250);
  assert.equal(await page.getByTestId("conversation").getAttribute("data-cache-count"), "0", "An old history response crossed thread boundaries");
  await page.getByTestId("composer-input").fill("Start");
  await page.getByTestId("send-button").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="stop-button"]'));
  await effortChip.click();
  assert.equal(await page.getByTestId("speed-toggle").isDisabled(), true, "Speed must not change during a running turn");
  await page.keyboard.press("Escape");
  await page.getByTestId("effort-menu").waitFor({ state: "detached" });
  const thought = { id: "thought-live", turnId: "live-turn", type: "thought", content: "正在分析当前问题", status: "done" };
  await page.evaluate(item => window.emitTest({ type: "upsert-item", item }), thought);
  await page.getByText(thought.content, { exact: true }).waitFor();
  await page.evaluate(() => window.emitTest({ type: "upsert-item", item: { id: "tool-live", turnId: "live-turn", type: "tool", name: "test", command: "test", status: "running" } }));
  assert(await page.getByText(thought.content, { exact: true }).isVisible());
  await page.evaluate(() => window.emitTest({ type: "upsert-item", item: { id: "answer-live", turnId: "live-turn", type: "message", role: "assistant", content: "最终回答", time: "" } }));
  await page.getByTestId("work-group").getByRole("button").waitFor();
  assert.equal(await page.getByTestId("work-group").getByRole("button").getAttribute("aria-expanded"), "false");
  await page.getByTestId("work-group").getByRole("button").click();
  await page.evaluate(() => window.emitTest({ type: "upsert-item", item: { id: "answer-live", turnId: "live-turn", type: "message", role: "assistant", content: "最终回答继续输出", time: "" } }));
  assert.equal(await page.getByTestId("work-group").getByRole("button").getAttribute("aria-expanded"), "true");
  await page.evaluate(() => window.askTest("claude"));
  const dialog = page.getByRole("dialog", { name: "Agent 提问" });
  await dialog.waitFor();
  await page.evaluate(() => {
    window.questionKeyLeaks = [];
    window.addEventListener("keydown", event => window.questionKeyLeaks.push(event.key));
  });
  await dialog.getByRole("button", { name: "收起提问" }).focus();
  await page.keyboard.press("1");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => window.questionKeyLeaks), [], "Modal keys reached underlying app shortcuts");
  await page.getByRole("button", { name: "回答问题", exact: true }).click();
  await dialog.waitFor();
  assert.equal(await dialog.locator("textarea").first().evaluate(element => {
    const event = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }), true, "IME composition must not submit the question");
  const fonts = await page.evaluate(() => {
    const family = getComputedStyle(document.documentElement).fontFamily;
    return [".question-dialog", ".question-dialog textarea", ".question-dialog button"].every(selector => getComputedStyle(document.querySelector(selector)).fontFamily === family);
  });
  assert.ok(fonts, "Question controls did not inherit the established UI font");
  if (process.env.CLEO_SMOKE_OUTPUT) {
    await mkdir(process.env.CLEO_SMOKE_OUTPUT, { recursive: true });
    await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "question-dark.png") });
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await page.screenshot({ path: join(process.env.CLEO_SMOKE_OUTPUT, "question-light.png") });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  }
  await dialog.getByRole("button", { name: "提交答案" }).click();
  assert.equal(await page.evaluate(() => window.answers.length), 0);
  await dialog.getByRole("radio", { name: /方式 A/ }).check();
  await dialog.getByRole("checkbox", { name: /前端/ }).check();
  await dialog.getByRole("checkbox", { name: /后端/ }).check();
  await dialog.locator("textarea").last().fill("保留我的输入");
  await dialog.getByRole("button", { name: "收起提问" }).click();
  await page.getByText("万条历史", { exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "回答问题", exact: true }).count(), 0);
  await page.locator(".thread-row-select").filter({ hasText: "Start" }).click();
  await page.getByRole("button", { name: "回答问题", exact: true }).click();
  assert.equal(await dialog.locator("textarea").last().inputValue(), "保留我的输入");
  await page.evaluate(() => { window.failAnswer = true; });
  await dialog.getByRole("button", { name: "提交答案" }).click();
  await dialog.getByText("模拟提交失败").waitFor();
  await dialog.getByRole("button", { name: "提交答案" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => window.answers[0].answers), { choice: ["A"], multiple: ["前端", "后端"], text: ["保留我的输入"] });
  await page.evaluate(() => window.askTest("codex"));
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "收起提问" }).click();
  await page.getByTestId("stop-button").click();
  const latest = page.getByRole("button", { name: /回到最新/ });
  if (await latest.count()) await latest.click();
  await page.getByText("提问已取消", { exact: true }).waitFor().catch(async error => {
    console.error(await page.locator(".question-history").allTextContents());
    throw error;
  });
  assert.equal(await page.getByRole("button", { name: "回答问题", exact: true }).count(), 0);
  assert.deepEqual(errors, []);

  // Remove the entry bundle only from this smoke's disposable build, then recover via the visible link.
  const bundleUrl = await page.locator('script[type="module"][src]').first().getAttribute("src");
  const bundle = resolve(appDir, "dist", bundleUrl);
  assert.equal(dirname(bundle), join(appDir, "dist", "assets"));
  await rename(bundle, bundle + ".unavailable");
  await page.reload();
  const retry = page.locator("#workspace-recovery a");
  await retry.waitFor();
  await rename(bundle + ".unavailable", bundle);
  await retry.click();
  await page.getByTestId("conversation").waitFor();
  assert.equal(await retry.isVisible(), false);

  // Exercise the actual Electron crash event. Only the native user's Retry selection is simulated.
  await application.evaluate(async ({ BrowserWindow, dialog }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    let prompted = false;
    dialog.showMessageBox = async () => { prompted = true; return { response: 0 }; };
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Renderer did not recover")), 15000);
      contents.once("did-finish-load", () => { clearTimeout(timeout); resolve(); });
      contents.forcefullyCrashRenderer();
    });
    if (!prompted || contents.isCrashed()) throw new Error("Workspace recovery failed");
  });

  // A reload that fails and is dismissed leaves an empty window; opening Cleo again must load the workspace.
  const index = join(appDir, "dist", "index.html");
  await rename(index, index + ".unavailable");
  await application.evaluate(async ({ BrowserWindow, dialog }) => {
    const answers = [0, 1];
    await new Promise(resolve => {
      dialog.showMessageBox = async () => {
        const response = answers.shift();
        if (!answers.length) resolve();
        return { response };
      };
      BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();
    });
  });
  await rename(index + ".unavailable", index);
  await application.evaluate(async ({ app, BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Opening Cleo again did not load the workspace")), 15000);
      contents.once("did-finish-load", () => { clearTimeout(timeout); resolve(); });
      app.emit("activate");
    });
  });
  await application.close();
  application = undefined;
  }
  if (process.env.CLEO_SMOKE_REGRESSION === "1") {
    for (const script of ["smoke.mjs", "smoke-approvals.mjs"]) {
      const result = spawnSync(process.execPath, [join(ui, "scripts", script)], {
        cwd: ui, stdio: "inherit", windowsHide: true,
        env: { ...process.env, CLEO_SMOKE_APP_DIR: appDir, CLEO_SMOKE_OUTPUT: join(scratch, script), CLEO_HOME: join(scratch, "home") },
      });
      assert.equal(result.status, 0, `${script} failed`);
    }
  }
  console.log(JSON.stringify({ status: "passed", history: !process.argv.includes("--regression-only"), regression: process.env.CLEO_SMOKE_REGRESSION === "1" }));
} finally {
  if (application) await application.close();
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
