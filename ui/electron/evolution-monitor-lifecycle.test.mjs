import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { monitorDisposition, needsEvolutionMonitor } from "./evolution-monitor-lifecycle.mjs";

const state = { active: "new", threadId: "evolution", iteration: { base: "old" } };
const ready = { protocol: 2, active: "new", mainInteractive: true, updatedAt: 10000 };

test("ordinary work and interactive Evolution editing/building do not launch companions", () => {
  assert.equal(needsEvolutionMonitor({}), false);
  assert.equal(needsEvolutionMonitor(state), false);
  assert.equal(needsEvolutionMonitor({ transaction: {} }), false);
  assert.equal(monitorDisposition({}, {}, 10000), "close");
  assert.equal(monitorDisposition(state, ready, 10000), "close");
});

test("only Evolution handoffs open the companion; recovery closes on the matching usable main", () => {
  const handoff = { ...state, transaction: { phase: "staged" } };
  assert.equal(needsEvolutionMonitor(handoff), true);
  assert.equal(monitorDisposition(handoff, ready, 10000), "show");
  assert.equal(monitorDisposition(state, { ...ready, mainInteractive: false }, 10000), "show");
  assert.equal(monitorDisposition(state, { ...ready, active: "old" }, 10000), "show");
  assert.equal(monitorDisposition(state, ready, 30000), "show");
  assert.equal(monitorDisposition({ ...state, lastRestartError: "failed" }, {}, 10000), "show");
  assert.equal(monitorDisposition(state, ready, 10000), "close");
});

test("real main entry opens after staging, never during agent turns or builds", async () => {
  const main = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
  const desktop = await readFile(new URL("./evolution-desktop.mjs", import.meta.url), "utf8");
  const calls = [...main.matchAll(/await evolutionDesktop\.openMonitor\(\)/g)];
  assert.equal(calls.length, 1);
  assert.ok(main.indexOf("const tx = await versions.stage(id)") < calls[0].index);
  assert.match(main, /app\.on\("cleo:healthy",[^]*?mainInteractive = true/);
  // The seam itself never opens the monitor on its own: only main's version switch and the explicit action do.
  assert.equal([...desktop.matchAll(/openEvolutionMonitor\(\)/g)].length, 2);
  assert.match(desktop, /monitor: \(\) => openEvolutionMonitor\(\)/);
  assert.match(desktop, /active: state.active, mainInteractive: mainInteractive\(\)/);
});
