import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DependencyUpdater, managedPython, readDependencyState, selectRuntime } from "./dependencies.mjs";
import { bundledPython } from "./platform.mjs";

test("only complete managed snapshots override the bundled runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-dependency-selection-"));
  const resources = join(root, "bundled");
  try {
    const name = "a".repeat(32);
    await writeFile(join(root, "state.json"), JSON.stringify({ active: name }));
    assert.equal(selectRuntime(root, resources).python, bundledPython(resources));
    const snapshot = join(root, name);
    await mkdir(dirname(managedPython(snapshot)), { recursive: true });
    await writeFile(managedPython(snapshot), "python");
    await mkdir(join(snapshot, "browser"));
    await writeFile(join(snapshot, "browser", "package.json"), "{}");
    const selected = selectRuntime(root, resources);
    assert.equal(selected.current, name);
    assert.equal(selected.python, managedPython(snapshot));
    assert.equal(selected.browserRoot, join(snapshot, "browser"));
    await writeFile(join(root, "state.json"), JSON.stringify({ active: "../outside" }));
    assert.equal(selectRuntime(root, resources).python, bundledPython(resources));
    await writeFile(join(root, "state.json"), "incomplete json");
    assert.deepEqual(readDependencyState(root), {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent update requests share one operation and cannot restart after shutdown", async () => {
  const updater = new DependencyUpdater({
    app: { getVersion: () => "0.3.0" }, resourcesPath: ".", cleoHome: tmpdir(),
  });
  updater.runtime = {};
  let release;
  let calls = 0;
  updater.checkInternal = () => {
    calls += 1;
    return new Promise((done) => { release = done; });
  };
  const first = updater.check();
  const second = updater.check();
  assert.equal(first, second);
  assert.equal(calls, 1);
  await updater.close();
  release();
  await first;
  await updater.check();
  assert.equal(calls, 1);
});
