import assert from "node:assert/strict";
import test from "node:test";
import { createQuitBarrier } from "../electron/shutdown.mjs";

function event() {
  return { prevented: 0, preventDefault() { this.prevented++; } };
}

test("a failing closer cannot end shutdown while another writer remains active", async () => {
  const writer = Promise.withResolvers();
  const failure = new Error("one closer failed");
  const calls = [];
  const handler = createQuitBarrier({
    close: [() => { calls.push("failed closer"); return Promise.reject(failure); },
      () => { calls.push("writer closing"); return writer.promise; }],
    onError: error => calls.push(error), quit: () => calls.push("quit"),
  });
  const request = event();
  const pending = handler(request);
  assert.equal(request.prevented, 1);
  assert.deepEqual(calls, ["failed closer", "writer closing"]);
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(!calls.includes("quit"));
  writer.resolve();
  await pending;
  assert.deepEqual(calls, ["failed closer", "writer closing", failure, "quit"]);
});

test("repeated quit requests wait on one barrier and never close resources twice", async () => {
  const writer = Promise.withResolvers();
  let closed = 0, quit = 0;
  const handler = createQuitBarrier({ close: [() => { closed++; return writer.promise; }],
    onError: assert.fail, quit: () => { quit++; } });
  const first = event(), second = event();
  const pending = handler(first);
  assert.equal(handler(second), pending);
  assert.equal(first.prevented, 1);
  assert.equal(second.prevented, 1);
  assert.equal(closed, 1);
  assert.equal(quit, 0);
  writer.resolve();
  await pending;
  assert.equal(quit, 1);
  const finalRequest = event();
  assert.equal(handler(finalRequest), undefined);
  assert.equal(finalRequest.prevented, 0);
  assert.equal(closed, 1);
  assert.equal(quit, 1);
});

test("normal shutdown starts all closers immediately and permits only the final quit", async () => {
  const calls = [];
  const finalRequest = event();
  let handler;
  handler = createQuitBarrier({ close: [() => calls.push("backend"), () => calls.push("downloads")],
    onError: assert.fail, quit: () => { calls.push("quit"); handler(finalRequest); } });
  const pending = handler(event());
  assert.deepEqual(calls, ["backend", "downloads"]);
  await pending;
  assert.deepEqual(calls, ["backend", "downloads", "quit"]);
  assert.equal(finalRequest.prevented, 0);
});

test("a synchronous closer exception is reported only after the other closer finishes", async () => {
  const writer = Promise.withResolvers();
  const failure = new Error("synchronous close failure");
  const errors = [];
  let quit = 0, started = false;
  const handler = createQuitBarrier({ close: [() => { throw failure; },
    () => { started = true; return writer.promise; }], onError: error => errors.push(error),
    quit: () => { quit++; } });
  const pending = handler(event());
  assert.equal(started, true);
  assert.equal(quit, 0);
  assert.deepEqual(errors, []);
  writer.resolve();
  await pending;
  assert.deepEqual(errors, [failure]);
  assert.equal(quit, 1);
});

test("a closer requesting quit synchronously reuses the established barrier", async () => {
  let handler, reentrant;
  let closed = 0, quit = 0;
  const nestedRequest = event();
  handler = createQuitBarrier({ close: [() => { closed++; reentrant = handler(nestedRequest); }],
    onError: assert.fail, quit: () => { quit++; } });
  const pending = handler(event());
  assert.equal(reentrant, pending);
  assert.equal(nestedRequest.prevented, 1);
  await pending;
  assert.equal(closed, 1);
  assert.equal(quit, 1);
});
