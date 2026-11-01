import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { after } from "node:test";
import { createServer } from "vite";
const server = await createServer({ root: resolve(import.meta.dirname, ".."), configFile: false,
  server: { middlewareMode: true, hmr: false } });
after(() => server.close());
const { modelGroups, selectModels } = await server.ssrLoadModule("/src/components/model-settings/routing-options.ts");
const items = [
  { id: "a/low", provider: "a", backend: "codex", model: "model", effort: "low", available: true, enabled: true },
  { id: "a/high", provider: "a", backend: "codex", model: "model", effort: "high", available: true, enabled: false },
  { id: "b/high", provider: "b", backend: "codex", model: "model", effort: "high", available: false, enabled: false },
];
test("model grouping separates connections and retains per-effort exclusions", () => {
  const groups = modelGroups(items);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].variants.length, 2);
  assert.equal(groups[1].available, false);
  assert.deepEqual(selectModels(items, [groups[0].id]).map(item => item.enabled), [true, false, false]);
});
test("user exclusion and re-enable cannot enable unsupported combinations", () => {
  const groups = modelGroups(items);
  const excluded = selectModels(items, []);
  assert.deepEqual(excluded.map(item => item.enabled), [false, false, false]);
  const selected = selectModels(excluded, groups.map(group => group.id));
  assert.deepEqual(selected.map(item => item.enabled), [true, true, false]);
});
