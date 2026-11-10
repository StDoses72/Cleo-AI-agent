import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { t as tr } from "../electron/i18n.mjs";
import { ProgramUpdates } from "../electron/program-updates.mjs";

/** Purpose: Run the handlers main.mjs actually registers, with the real update coordinator.
 * Input: none. Output: the request and recovery handlers plus the fakes they close over.
 */
async function boundary() {
  const main = (await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const slice = (start, end) => {
    const from = main.indexOf(start);
    const to = main.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `main.mjs must contain ${start}`);
    return main.slice(from, to);
  };
  const declarations = ["allowedMethods", "retiredMethods"].map(name =>
    main.match(new RegExp(`const ${name} = new Set\\(\\[[\\s\\S]*?\\]\\);`))?.[0]);
  assert.ok(declarations.every(Boolean), "method tables must exist");
  const updates = [];
  const program = new ProgramUpdates({ updater: { setState: state => updates.push(state) },
    hasRunningTask: () => backend.pending.size > 0 || setup.busy });
  const handlers = new Map();
  const turns = [];
  const calls = [];
  const setup = { busy: false };
  const versions = { phase: "idle", store: { read: async () => ({}) },
    operation: async (phase, action) => { calls.push(["operation", phase]); return action(); },
    ensureBaseline: async () => { calls.push(["baseline"]); } };
  const backend = { pending: new Map(), request: async (method, params) => {
    calls.push(["backend", method]);
    if (method === "stream_turn") return "task started";
    if (method === "steer_run") return "steer forwarded";
    throw new Error(`Unexpected request: ${method}`);
  } };
  const recovery = { selection: undefined };
  vm.runInNewContext([...declarations,
    slice('ipcMain.handle("cleo:request",', 'ipcMain.handle("cleo:pick-attachments",'),
    slice('ipcMain.handle("cleo:program:recovery",', 'if (!app.isPackaged) ipcMain.handle("cleo:program:healthy",')].join("\n"), {
    ipcMain: { handle: (name, callback) => { handlers.set(name, callback); } },
    programUpdates: program, tr, setup, versions, backend,
    computer: { broker: { turnStarted: thread => turns.push(["start", thread]), turnEnded: thread => turns.push(["end", thread]) } },
    BrowserWindow: { fromWebContents: sender => sender },
    showRecovery: async (store, options) => { calls.push(["chooser", store === versions.store, options.selectOnly]); return recovery.selection; },
    applyVersion: async id => { calls.push(["apply", id, program.busy]); return true; },
  });
  return { request: handlers.get("cleo:request"), openRecovery: handlers.get("cleo:program:recovery"),
    program, updates, turns, calls, setup, versions, backend, recovery };
}

test("a download in progress leaves conversations available; writing version operations do not", async () => {
  const { request, program, updates, turns, versions, setup } = await boundary();
  const turn = thread => request({}, { method: "stream_turn", params: { thread_id: thread } });
  const steer = () => request({}, { method: "steer_run", params: { thread_id: "ordinary" } });
  let finish;
  const downloading = program.run(() => new Promise(resolve => { finish = resolve; }), { allowRunning: true });
  assert.equal(program.busy, true);
  assert.equal(program.blocksTasks, false);
  assert.equal(updates.at(-1).blocksTasks, false);
  assert.equal(await turn("ordinary"), "task started");
  // Computer use binds tool calls to running turns; the turn is released when it ends.
  assert.deepEqual(turns, [["start", "ordinary"], ["end", "ordinary"]]);
  assert.equal(await steer(), "steer forwarded");
  versions.phase = "downloading";
  await assert.rejects(turn("ordinary"), /等待当前版本操作/);
  await assert.rejects(steer(), /等待当前版本操作/);
  versions.phase = "idle";
  versions.store.read = async () => ({ transaction: { phase: "staged" } });
  await assert.rejects(turn("ordinary"), /等待当前版本操作/);
  await assert.rejects(steer(), /等待当前版本操作/);
  versions.store.read = async () => ({});
  setup.busy = true;
  await assert.rejects(turn("ordinary"), /版本或依赖操作/);
  setup.busy = false;
  finish("downloaded");
  assert.equal(await downloading, "downloaded");
  assert.equal(program.busy, false);
  program.beginRestart();
  await assert.rejects(turn("ordinary"), /版本或依赖操作/);
  assert.deepEqual(turns, [["start", "ordinary"], ["end", "ordinary"]], "A refused turn must not claim computer use");
});

test("in-app recovery retains a baseline first and restarts only into an explicit selection", async () => {
  const { openRecovery, program, calls, setup, backend, recovery } = await boundary();
  const event = { sender: { id: "main-window" } };
  backend.pending.set("running-task", {});
  await assert.rejects(async () => openRecovery(event), /等待当前任务/);
  backend.pending.clear();
  setup.busy = true;
  await assert.rejects(async () => openRecovery(event), /依赖/);
  setup.busy = false;
  assert.deepEqual(calls, [], "A refused request must not prepare or show anything");
  assert.equal(await openRecovery(event), undefined);
  assert.deepEqual(calls, [["operation", "preparing"], ["baseline"], ["chooser", true, true]]);
  assert.equal(program.busy, false);
  calls.length = 0;
  recovery.selection = "base";
  assert.equal(await openRecovery(event), true);
  assert.deepEqual(calls.at(-1), ["apply", "base", true], "The switch runs as the one version operation in progress");
  program.close();
  await assert.rejects(async () => openRecovery(event), /正在退出/);
});

test("the removed evolution thread method reports the feature as gone without reaching the backend", async () => {
  const { request, calls } = await boundary();
  await assert.rejects(request({}, { method: "open_evolution_thread", params: {} }), /不再提供本地进化/);
  await assert.rejects(request({}, { method: "analyze_evolution_request", params: {} }), /Unsupported desktop method/);
  assert.deepEqual(calls, []);
});
