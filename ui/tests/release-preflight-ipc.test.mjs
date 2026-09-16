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
  const updates = [];
  const program = new ProgramUpdates({ updater: { setState: state => updates.push(state) }, hasRunningTask: () => true });
  let handler;
  let finish;
  let publications = 0;
  vm.runInNewContext(main.slice(start, end), {
    ipcMain: { handle: (_name, callback) => { handler = callback; } },
    programUpdates: program,
    backend: { pending: new Map([["running-task", {}]]) },
    evolution: {},
    checkReleasePermission: async () => ({ canRelease: true }),
    previewMergedRelease: async (_manager, params) => new Promise(resolve => { finish = () => resolve({ url: params.url, commit: "verified" }); }),
    releaseJobs: { start: () => { publications++; } },
  });
  const reading = handler({}, { action: "previewMergedRelease", url: "https://github.com/test/repo/pull/1" });
  assert.equal(program.busy, true);
  assert.equal(program.blocksTasks, false);
  assert.equal(updates.at(-1).blocksTasks, false);
  finish();
  assert.equal((await reading).commit, "verified");
  assert.equal(program.busy, false);
  assert.equal((await handler({}, { action: "releasePermission" })).canRelease, true);
  assert.equal(publications, 0);
  await assert.rejects(handler({}, { action: "prepare" }), /等待当前任务/);
});
