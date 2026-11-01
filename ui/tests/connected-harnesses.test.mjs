import assert from "node:assert/strict";
import test from "node:test";
import { checkHarnessConnections } from "../src/connected-harnesses.ts";

test("the picker only offers harnesses whose model discovery succeeds", async () => {
  const candidates = ["codex", "claude", "gemini", "opencode"].map(id => ({ id }));
  const found = [];
  const catalog = { provider: "opencode", source: "acp", models: [{ id: "deepseek/deepseek-chat" }] };
  await checkHarnessConnections(candidates, async provider => {
    if (provider === "opencode") return catalog;
    if (provider === "gemini") return { provider, source: "acp", models: [] };
    throw new Error("Client missing or not logged in");
  }, (provider, models) => found.push({ provider, models }));
  assert.deepEqual(found, [{ provider: candidates[3], models: catalog }]);
});

test("successful harnesses appear before a slow client finishes checking", async () => {
  let finish;
  const slow = new Promise(resolve => { finish = resolve; });
  const found = [];
  const checking = checkHarnessConnections([{ id: "slow" }, { id: "ready" }], async id => {
    if (id === "slow") await slow;
    return { provider: id, source: "sdk", models: [{ id: "live-model" }] };
  }, provider => found.push(provider.id));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(found, ["ready"]);
  finish();
  await checking;
  assert.deepEqual(found, ["ready", "slow"]);
});
