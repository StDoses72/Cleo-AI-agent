import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { nextPendingSwitch, runtimeWithPendingSwitch } from "../src/harness-handoff.ts";

const live = { provider: "codex", model: "gpt-5.6-sol", effort: "low", access: "default", approval: "default",
  supportsFastMode: true, serviceTier: "fast", permissionOptions: { access: [], approval: [] } };
const catalog = { productivityProviders: [
  { id: "codex", type: "codex_sdk", permissionOptions: { access: [{ value: "a" }], approval: [] } },
  { id: "claude", type: "claude_sdk", permissionOptions: { access: [], approval: [{ value: "b" }] } },
] };

test("picking another harness leaves it pending; picking the live one back cancels", () => {
  const pick = { provider: "claude", model: "claude-opus-5", effort: "high" };
  assert.deepEqual(nextPendingSwitch(live, pick), pick);
  assert.equal(nextPendingSwitch(live, { provider: "codex", model: "gpt-5.6-sol", effort: "low" }), null);
  // Same harness, other model: still applied with the next message, not at once.
  assert.deepEqual(nextPendingSwitch(live, { provider: "codex", model: "gpt-5.6-terra", effort: "medium" }),
    { provider: "codex", model: "gpt-5.6-terra", effort: "medium" });
});

test("the pill reads as the task will run after the handoff, with the picked harness's abilities", () => {
  assert.equal(runtimeWithPendingSwitch(live, null, catalog), live);
  const shown = runtimeWithPendingSwitch(live, { provider: "claude", model: "claude-opus-5", effort: "high" }, catalog);
  assert.equal(shown.provider, "claude");
  assert.equal(shown.model, "claude-opus-5");
  assert.equal(shown.effort, "high");
  assert.equal(shown.supportsFastMode, false);
  assert.equal(shown.serviceTier, null);
  assert.deepEqual(shown.permissionOptions, catalog.productivityProviders[1].permissionOptions);
  const codex = runtimeWithPendingSwitch(live, { provider: "codex", model: "gpt-5.6-terra", effort: null, serviceTier: "fast" }, catalog);
  assert.equal(codex.serviceTier, "fast");
  assert.equal(codex.supportsFastMode, true);
});

test("the renderer hands off in sendPrompt only, never when a harness is picked", async () => {
  const source = await readFile(new URL("../src/useCleoWorkspace.ts", import.meta.url), "utf8");
  const body = (name) => {
    const start = source.indexOf(`const ${name} = `);
    assert.ok(start >= 0, `${name} must exist`);
    const end = source.slice(start).search(/\r?\n  };/);
    assert.ok(end > 0, `${name} must end`);
    return source.slice(start, start + end);
  };
  assert.ok(!body("selectProductivityRuntime").includes("switchHarness("), "picking must not switch");
  assert.ok(body("selectProductivityRuntime").includes("nextPendingSwitch("), "picking records the choice");
  assert.ok(!body("updateRuntime").includes("switchHarness("), "effort changes must not switch");
  assert.equal((body("sendPrompt").match(/cleoClient\s*\.switchHarness\(/g) ?? []).length, 1,
    "sending hands off exactly once");
});
