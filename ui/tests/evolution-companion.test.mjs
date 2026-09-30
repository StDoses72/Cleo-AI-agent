import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvolutionMonitorStore } from "../electron/evolution-monitor-store.mjs";
import { EvolutionCompanion } from "../electron/evolution-companion.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cleo-companion-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EvolutionMonitorStore(root);
  const state = { threadId: "evolution", active: "saved", iteration: { id: "iteration", base: "saved" }, builds: [{ id: "saved", savedAt: "today" }] };
  const calls = [];
  const companion = new EvolutionCompanion({ store, evolution: { store: { read: async () => state } },
    backend: { request: async (method, params) => {
      calls.push([method, params]);
      if (method === "get_pending_questions") return [{ id: "q", questions: [{ id: "choice" }] }];
      return { id: "evolution", items: [], status: "completed" };
    } }, ready: () => true,
    turn: async params => { await store.claim(params.run_id); calls.push(["turn", params]); await store.receipt(params.run_id, "completed"); },
    stop: async () => { calls.push(["stop"]); }, discard: async () => { calls.push(["discard"]); }, rollback: async id => { calls.push(["rollback", id]); },
  });
  return { companion, store, state, calls };
}

test("companion sends queued chat without a renderer, consumes it once and preserves the session", async t => {
  const { companion, store, calls } = await fixture(t);
  const message = await store.enqueue("evolution", "保留布局");
  await companion.tick(); await companion.turnTask;
  await companion.tick();
  assert.deepEqual(calls.filter(([method]) => method === "turn").map(([, params]) => [params.thread_id, params.prompt, params.run_id]), [["evolution", "保留布局", message.id]]);
  assert.equal((await store.messages())[0].status, "completed");
});

test("stop controls remain responsive during a turn and pause queued followups", async t => {
  const { companion, store, calls } = await fixture(t);
  let finish;
  companion.turn = () => new Promise(resolve => { finish = resolve; });
  companion.stop = async () => { calls.push(["stop"]); finish(); };
  await store.enqueue("evolution", "运行中的任务");
  await companion.tick();
  await store.command("stop", "evolution");
  await companion.tick();
  assert.equal(await store.paused(), true);
  assert.equal(calls.filter(([method]) => method === "stop").length, 1);
  assert.equal((await store.commands())[0].status, "completed");
});

test("discard cancels pending chat only for this iteration after stopping the agent", async t => {
  const { companion, store, state, calls } = await fixture(t);
  await store.enqueue("evolution", "尚未发送"); await store.enqueue("other", "other task");
  await store.command("discard", "evolution", { active: state.active, iteration: state.iteration.id });
  await companion.tick();
  assert.deepEqual(calls.map(([method]) => method), ["stop", "discard"]);
  assert.deepEqual((await store.messages()).map(message => message.status), ["cancelled", "queued"]);
  await companion.tick();
  assert.equal(calls.length, 2);
});

test("stale recovery targets cannot discard new edits and started controls never replay after restart", async t => {
  const { companion, store, calls } = await fixture(t);
  await store.command("discard", "evolution", { active: "old", iteration: "old" });
  await companion.tick();
  assert.equal(calls.length, 0);
  assert.equal((await store.commands())[0].status, "error");
  const claimed = await store.command("discard", "evolution");
  await store.commandResult(claimed.id, "started");
  await companion.tick();
  assert.equal(calls.length, 0);
});

test("recovery delegates to the existing version controller and answers target the pending question", async t => {
  const { companion, store, state, calls } = await fixture(t);
  await store.command("answer", "evolution", { questionId: "q", answers: { choice: ["紧凑"] } });
  await companion.tick();
  assert.equal(calls.at(-1)[0], "resolve_question");
  await store.command("rollback", "evolution", { active: state.active, iteration: state.iteration.id, targetId: "saved" });
  await companion.tick();
  assert.deepEqual(calls.slice(-2), [["stop"], ["rollback", "saved"]]);
});

test("tool output is upserted, bounded, and assistant replies survive projection", async t => {
  const { companion } = await fixture(t);
  companion.event("evolution", { type: "upsert-item", item: { id: "tool", type: "tool", name: "Read", status: "running" } });
  companion.event("evolution", { type: "upsert-item", item: { id: "tool", type: "tool", name: "Read", status: "done", output: "x".repeat(20000) } });
  companion.event("evolution", { type: "upsert-item", item: { id: "reply", type: "message", role: "assistant", content: "完成" } });
  assert.equal(companion.snapshot().items.length, 2);
  assert.equal(companion.snapshot().items[0].output.length, 16000);
  assert.equal(companion.snapshot().items[1].content, "完成");
});

test("check, apply and save run from the companion only when the main program allows them", async t => {
  const { companion, store, calls } = await fixture(t);
  const base = { id: "base", kind: "official", version: "0.5.18" };
  const candidate = { id: "cand", kind: "local", version: "0.5.18", sourceHash: "h" };
  let status = { phase: "idle", threadId: "evolution", builds: [base], active: "base", iteration: { id: "it", base: "base" },
    validation: { status: "pending" } };
  companion.evolution.status = async () => status;
  companion.build = async () => { calls.push(["build"]); };
  companion.apply = async id => { calls.push(["apply", id]); };
  companion.save = async name => { calls.push(["save", name]); };

  await store.command("apply", "evolution");
  await companion.tick();
  assert.equal((await store.commands()).at(-1).status, "error");
  await store.command("build", "evolution");
  await companion.tick();
  assert.deepEqual(calls.at(-1), ["build"]);

  status = { ...status, builds: [base, candidate], candidate: "cand", validation: { status: "passed", sourceHash: "h", candidate: "cand" } };
  await store.command("apply", "evolution");
  await companion.tick();
  assert.deepEqual(calls.at(-1), ["apply", "cand"]);
  assert.equal((await store.commands()).at(-1).status, "completed");

  status = { ...status, active: "cand" };
  await store.command("save", "evolution", { name: "  " });
  await companion.tick();
  assert.deepEqual(calls.at(-1), ["save", "0.5.19"]);
  await store.command("save", "evolution", { name: "我的版本" });
  await companion.tick();
  assert.deepEqual(calls.at(-1), ["save", "我的版本"]);

  companion.ready = () => false;
  await store.command("build", "evolution");
  await companion.tick();
  assert.match((await store.commands()).at(-1).detail, /正在修改或检查/);
});
