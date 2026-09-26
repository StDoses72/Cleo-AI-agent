import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { ProgramUpdates } from "../electron/program-updates.mjs";

test("automatic release preflight leaves conversations available and never dispatches publication", async () => {
  const main = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const start = main.indexOf('ipcMain.handle("cleo:evolution:action",');
  const end = main.indexOf('if (!app.isPackaged) ipcMain.handle("cleo:evolution:healthy",', start);
  assert(start >= 0 && end > start);
  const requestStart = main.indexOf('ipcMain.handle("cleo:request",');
  const requestEnd = main.indexOf('ipcMain.handle("cleo:pick-attachments",', requestStart);
  const allowlist = main.match(/const allowedMethods = new Set\(\[[\s\S]*?\]\);/)[0];
  const updates = [];
  const program = new ProgramUpdates({ updater: { setState: state => updates.push(state) }, hasRunningTask: () => true });
  const handlers = new Map();
  let finish;
  let publications = 0;
  const evolution = { phase: "idle", readOnlyOperation: false, store: { read: async () => ({}) } };
  vm.runInNewContext(`${allowlist}\n${main.slice(requestStart, requestEnd)}\n${main.slice(start, end)}`, {
    ipcMain: { handle: (name, callback) => { handlers.set(name, callback); } },
    programUpdates: program,
    setup: { busy: false },
    companion: { controlling: false },
    backend: { pending: new Map([["running-task", {}]]), request: async (method, params) => {
      if (method === "is_evolution_thread") return params.thread_id === "evolution";
      if (method === "stream_turn") return "ordinary task started";
      if (method === "steer_run") return "steer forwarded to existing task";
      throw new Error(`Unexpected request: ${method}`);
    } },
    evolution,
    checkReleasePermission: async () => ({ canRelease: true }),
    previewMergedRelease: async (_manager, params) => new Promise(resolve => {
      evolution.phase = "checking"; evolution.readOnlyOperation = true;
      finish = () => { evolution.phase = "idle"; evolution.readOnlyOperation = false; resolve({ url: params.url, commit: "verified" }); };
    }),
    releaseJobs: { start: () => { publications++; } },
  });
  const handler = handlers.get("cleo:evolution:action");
  const request = handlers.get("cleo:request");
  const reading = handler({}, { action: "previewMergedRelease", url: "https://github.com/test/repo/pull/1" });
  assert.equal(program.busy, true);
  assert.equal(program.blocksTasks, false);
  assert.equal(updates.at(-1).blocksTasks, false);
  assert.equal(await request({}, { method: "stream_turn", params: { thread_id: "ordinary" } }), "ordinary task started");
  assert.equal(await request({}, { method: "steer_run", params: { thread_id: "ordinary" } }), "steer forwarded to existing task");
  await assert.rejects(request({}, { method: "stream_turn", params: { thread_id: "evolution" } }), /等待/);
  evolution.readOnlyOperation = false;
  await assert.rejects(request({}, { method: "stream_turn", params: { thread_id: "ordinary" } }), /等待/);
  await assert.rejects(request({}, { method: "steer_run", params: { thread_id: "ordinary" } }), /等待/);
  evolution.readOnlyOperation = true;
  evolution.store.read = async () => ({ transaction: { phase: "applying" } });
  await assert.rejects(request({}, { method: "stream_turn", params: { thread_id: "ordinary" } }), /等待/);
  await assert.rejects(request({}, { method: "steer_run", params: { thread_id: "ordinary" } }), /等待/);
  evolution.store.read = async () => ({});
  finish();
  assert.equal((await reading).commit, "verified");
  assert.equal(program.busy, false);
  assert.equal((await handler({}, { action: "releasePermission" })).canRelease, true);
  assert.equal(publications, 0);
  await assert.rejects(handler({}, { action: "prepare" }), /等待当前任务/);
});
