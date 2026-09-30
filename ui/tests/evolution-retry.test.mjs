import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

test("App retry sends unchanged instructions to the resolved task after connection failure", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const start = source.indexOf("  const sendEvolutionPrompt =");
  const end = source.indexOf("  /** Purpose: Return compiler/runtime diagnostics", start);
  assert.ok(start >= 0 && end > start);
  // Run the actual callback with its original-render closure, including the retry it installs.
  const outputText = stripTypeScriptTypes(source.slice(start, end)) + "\nreturn sendEvolutionPrompt;";
  const retryEvolution = { current: () => {} };
  const sent = [];
  const actions = [];
  let opened = 0, issue = null;
  const evolution = { refresh: async () => {}, run: async (action, params) => {
    actions.push([action, params]);
    assert.equal(action, "thread", "Direct conversation must not invoke the removed planning workflow");
  } };
  const workspace = { openEvolutionThread: async id => ({ id }), sendPrompt: async (prompt, thread) => {
    sent.push({ prompt, threadId: thread.id });
    if (sent.length === 1) throw new Error("temporary connection failure");
  } };
  const send = new Function("preparingEvolution", "setPreparingTurn", "retryEvolution", "setEvolutionIssue",
    "workspace", "evolutionThread", "startEvolution", "evolution", outputText)(
    { current: false }, () => {}, retryEvolution, value => { issue = value; }, workspace, false,
    async () => ({ id: `thread-${++opened}` }), evolution);
  await send("original request");
  assert.equal(issue, "temporary connection failure");
  retryEvolution.current();
  for (let i = 0; i < 100 && sent.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(issue, null);
  assert.deepEqual(sent, [
    { prompt: "original request", threadId: "thread-1" },
    { prompt: "original request", threadId: "thread-1" },
  ]);
  assert.equal(actions.length, 2);
  assert.equal(opened, 1);
});
