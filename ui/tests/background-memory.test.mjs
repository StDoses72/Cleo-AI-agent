import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundMemoryScheduler } from "../electron/background-memory.mjs";

test("background polling starts no backend and yields when foreground work is busy", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let idle = true;
  const calls = [];
  const backend = { process: null, request: async method => calls.push(method) };
  const scheduler = createBackgroundMemoryScheduler({ backend, canRun: () => idle, onError: assert.fail });
  t.after(() => scheduler.stop());
  scheduler.start();
  scheduler.start();
  t.mock.timers.tick(30_000);
  assert.deepEqual(calls, []);
  backend.process = {};
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.deepEqual(calls, ["run_background_memory_review"]);
  idle = false;
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.deepEqual(calls, ["run_background_memory_review", "cancel_background_memory_review"]);
  scheduler.stop();
  scheduler.start();
  t.mock.timers.tick(60_000);
  assert.equal(calls.length, 2);
});

test("slow checks never overlap and shutdown cannot dispatch another check", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const request = Promise.withResolvers();
  let calls = 0;
  const scheduler = createBackgroundMemoryScheduler({
    backend: { process: {}, request: () => { calls++; return request.promise; } },
    canRun: () => true, onError: assert.fail,
  });
  t.after(() => scheduler.stop());
  scheduler.start();
  t.mock.timers.tick(90_000);
  assert.equal(calls, 1);
  scheduler.stop();
  request.resolve();
  await Promise.resolve();
  t.mock.timers.tick(30_000);
  assert.equal(calls, 1);
});

test("failed checks report the error and allow a later check", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const failure = new Error("backend disconnected");
  const errors = [];
  let calls = 0;
  const scheduler = createBackgroundMemoryScheduler({
    backend: { process: {}, request: async () => { if (++calls === 1) throw failure; } },
    canRun: () => true, onError: error => errors.push(error),
  });
  t.after(() => scheduler.stop());
  scheduler.start();
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.deepEqual(errors, [failure]);
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.equal(calls, 2);
});
