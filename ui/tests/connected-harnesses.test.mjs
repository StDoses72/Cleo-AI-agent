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

test("harnesses that fail their check or offer no models are reported as unavailable", async () => {
  const candidates = ["codex", "gemini", "opencode"].map(id => ({ id }));
  const connected = [];
  const unavailable = [];
  await checkHarnessConnections(candidates, async provider => {
    if (provider === "opencode") return { provider, source: "acp", models: [{ id: "glm" }] };
    if (provider === "gemini") return { provider, source: "acp", models: [] };
    throw new Error("Client missing or not logged in");
  }, provider => connected.push(provider.id), provider => unavailable.push(provider.id));
  assert.deepEqual(connected, ["opencode"]);
  assert.deepEqual(unavailable.sort(), ["codex", "gemini"]);
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
