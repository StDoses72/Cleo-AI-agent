import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// Run the actual registered Electron handler, not the renderer mock client.
async function boundary() {
  const main = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const allowlist = main.match(/const allowedMethods = new Set\(\[[\s\S]*?\]\);/);
  assert.ok(allowlist, "desktop method allowlist must exist");
  const start = main.indexOf('ipcMain.handle("cleo:request",');
  const end = main.indexOf('ipcMain.handle("cleo:pick-attachments",', start);
  assert.ok(start >= 0 && end > start, "real request handler must be located");
  const calls = [];
  let handler;
  vm.runInNewContext(`${allowlist[0]}\n${main.slice(start, end)}`, {
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    programUpdates: { closed: false, blocksTasks: false, busy: false },
    backend: { request: async (method, params) => {
      calls.push({ method, params });
      return { provider: params.provider, model: params.model, switched: true };
    } },
  });
  return { handler, calls };
}

test("switch_harness crosses the actual desktop IPC boundary with its parameters", async () => {
  const { handler, calls } = await boundary();
  const params = { thread_id: "existing-session", provider: "claude", model: "model", effort: "high" };
  const result = await handler({}, { method: "switch_harness", params });
  assert.deepEqual(calls, [{ method: "switch_harness", params }]);
  assert.equal(result.switched, true);
});

test("unregistered desktop methods remain rejected before backend dispatch", async () => {
  const { handler, calls } = await boundary();
  await assert.rejects(handler({}, { method: "unregistered_method" }), /Unsupported desktop method/);
  assert.equal(calls.length, 0);
});

test("every literal renderer bridge request is registered by the desktop", async () => {
  const main = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const client = await readFile(new URL("../src/services/ipcCleoClient.ts", import.meta.url), "utf8");
  const declaration = main.match(/const allowedMethods = new Set\(\[[\s\S]*?\]\);/)[0];
  const registered = new Set([...declaration.matchAll(/"([a-z_]+)"/g)].map(match => match[1]));
  const requested = [...client.matchAll(/this\.bridge\.request\(\s*"([a-z_]+)"/g)].map(match => match[1]);
  assert.ok(requested.includes("switch_harness"));
  assert.deepEqual(requested.filter(method => !registered.has(method)), []);
});
