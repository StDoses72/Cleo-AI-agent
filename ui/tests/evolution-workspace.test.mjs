import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvolutionMonitorStore } from "../electron/evolution-monitor-store.mjs";
import { runEvolutionTurn } from "../electron/evolution-editing.mjs";

test("ordinary requests reach the coding harness unchanged without case planning or automatic builds", async () => {
  const calls = [];
  const evolution = { begin: async () => calls.push("begin"), recordValidation: async value => calls.push(value.status),
    build: () => assert.fail("Each reply must not build a release") };
  const params = { thread_id: "evolution", prompt: "先改颜色；我稍后补充需求" };
  const backend = { request: async (method, received, emit) => {
    assert.equal(method, "stream_turn"); assert.equal(received, params);
    emit({ type: "question-request", request: { title: "深色还是浅色？" } }); emit({ type: "done" }); return "ok";
  } };
  const events = [];
  assert.equal(await runEvolutionTurn({ evolution, backend, params, onEvent: event => events.push(event) }), "ok");
  assert.deepEqual(calls, ["begin", "pending"]); assert.equal(events[0].type, "question-request");
});

test("messages survive separate monitor/app instances and an ambiguous delivery cannot replay", async t => {
  const root = await mkdtemp(join(tmpdir(), "cleo-monitor-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const monitor = new EvolutionMonitorStore(root);
  const app = new EvolutionMonitorStore(root);
  const first = await monitor.enqueue("session-a", "重启期间补充：保留旧颜色");
  await monitor.enqueue("session-b", "另一个会话");
  assert.equal((await app.pending("session-a")).id, first.id);
  const claims = await Promise.allSettled([app.claim(first.id), new EvolutionMonitorStore(root).claim(first.id)]);
  assert.equal(claims.filter(result => result.status === "fulfilled").length, 1);
  const restarted = new EvolutionMonitorStore(root);
  assert.equal(await restarted.pending("session-a"), null);
  assert.equal((await restarted.messages()).find(item => item.id === first.id).status, "started");
  await app.receipt(first.id, "completed");
  assert.equal((await monitor.messages()).find(item => item.id === first.id).status, "completed");
  assert.equal(await app.message("../../state"), null);
  await assert.rejects(app.enqueue("", "hello"), /会话/);
});
