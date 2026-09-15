import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stripTypeScriptTypes } from "node:module";
import { EvolutionRequests } from "../electron/evolution-requests.mjs";
import { EvolutionAcceptance } from "../electron/evolution-acceptance.mjs";

test("App retry keeps the resolved thread after preparation fails in a newly opened task", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cleo-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = { root, read: async () => ({ active: "base", builds: [] }) };
  let attempts = 0;
  const requests = new EvolutionRequests(new EvolutionAcceptance(store), async () => {
    if (!attempts++) throw new Error("temporary model failure");
    return { intent: "question", answer: "recovered without editing" };
  });
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  // Execute the production callback, retaining its original-render closure across a retry.
  const callback = source.slice(source.indexOf("  const sendEvolutionPrompt ="), source.indexOf("  /** Purpose: Give the original editing task"));
  assert.ok(callback.includes("prepareRequest"));
  const outputText = stripTypeScriptTypes(callback) + "\nreturn sendEvolutionPrompt;";
  const retryEvolution = { current: () => {} };
  let opened = 0, issue = null;
  const evolution = { refresh: async () => {}, run: async (action, params) => {
    if (action === "thread") return;
    if (action === "prepareRequest") return requests.prepare(params);
    throw new Error(`Unexpected ${action}`);
  } };
  const workspace = { openEvolutionThread: async (id) => ({ id }) };
  const send = new Function("preparingEvolution", "setPreparingAcceptance", "retryEvolution", "setEvolutionIssue",
    "workspace", "evolutionThread", "startEvolution", "evolution", outputText)(
    { current: false }, () => {}, retryEvolution, (value) => { issue = value; }, workspace, false,
    async () => ({ id: `thread-${++opened}` }), evolution);
  await send("original request", false, "same-request");
  assert.equal(issue, "temporary model failure");
  const original = (await requests.read()).requests[0];
  retryEvolution.current();
  for (let i = 0; i < 100 && (await requests.read()).requests[0].status !== "answered"; i++) {
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.equal(issue, null, `Retry failed: ${issue}`);
  const recovered = (await requests.read()).requests;
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].threadId, original.threadId);
  assert.equal(recovered[0].status, "answered");
  assert.equal(opened, 1);
});
