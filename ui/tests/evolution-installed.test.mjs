import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { EvolutionManager } from "../electron/evolution.mjs";
import { exists, writeJson } from "../electron/evolution-store.mjs";
import { runHandoff } from "../electron/evolution-handoff.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cleo-installed-test-"));
  const manager = new EvolutionManager({
    app: { isPackaged: true, getVersion: () => "0.4.0" },
    root: join(root, "profile/evolution"), dataHome: join(root, "home"),
  });
  const bundle = join(root, "installed", manager.target.bundle);
  manager.executable = join(bundle, manager.target.executable);
  const resources = join(bundle, manager.target.resources);
  await mkdir(resources, { recursive: true });
  await mkdir(dirname(manager.executable), { recursive: true });
  await writeFile(manager.executable, "new executable");
  await writeFile(join(resources, "app.asar"), "new application archive");
  await writeFile(join(resources, "evolution-source.tar.gz"), "official releases also include source");
  const metadataPath = join(bundle, manager.target.platform === "darwin" ? manager.target.resources : "", "release.json");
  const metadata = { schema_version: 1, app: "Cleo", version: "0.4.0", platform: manager.target.id, evolution_protocol: 2 };
  await writeJson(metadataPath, metadata);
  const executable = `${manager.target.bundle}/${manager.target.executable}`;
  await mkdir(dirname(join(manager.store.root, "builds/old", executable)), { recursive: true });
  await writeFile(join(manager.store.root, "builds/old", executable), "old executable");
  await manager.store.update({ active: "old", baseline: "old", workspaceBase: "old",
    builds: [{ id: "old", kind: "official", version: "0.3.10", baseTag: "v0.3.10", executable, baseline: true }] });
  await mkdir(join(manager.store.dataHome, "data"), { recursive: true });
  await writeFile(join(manager.store.dataHome, "data/chat.txt"), "latest chat");
  t.after(async () => {
    await manager.close();
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, manager, bundle, resources, metadataPath, metadata };
}

test("a manually installed release supersedes the old official selection through a recoverable handoff", async (t) => {
  const { manager } = await fixture(t);
  await mkdir(manager.source);
  await writeFile(join(manager.source, "source.txt"), "old prepared source");
  await manager.store.update({ prepared: true, baseTag: "v0.3.10", threadId: "old-source-thread" });
  assert.equal((await manager.installedRelease()).version, "0.4.0");
  const tx = await manager.stageInstalledRelease();
  assert.equal((await manager.store.read()).active, "old", "Copying must not activate the new program early");
  assert.equal(tx.officialSelection.baseTag, "v0.4.0");
  const build = await manager.store.build(tx.to);
  assert.equal(build.kind, "official", "A downloaded release must not become a local development build");
  assert.equal(build.version, "0.4.0");
  assert.equal(await readFile(join(build.directory, manager.target.bundle, manager.target.resources, "app.asar"), "utf8"), "new application archive");
  await manager.store.activate();
  await manager.store.healthy(tx.id);
  const state = await manager.store.read();
  assert.equal(state.active, tx.to);
  assert.equal(state.workspaceBase, tx.to);
  assert.equal(state.baseTag, "v0.4.0");
  assert.equal(state.prepared, false);
  assert.equal(await readFile(join(manager.store.root, tx.officialSelection.sourceArchive, "source.txt"), "utf8"), "old prepared source");
  assert.equal(await readFile(join(manager.store.dataHome, "data/chat.txt"), "utf8"), "latest chat");
  await manager.store.build("old");
  assert.equal(await manager.installedRelease(), null);
});

test("explicit rollback stays selected even after the imported release has been pruned", async (t) => {
  const { manager } = await fixture(t);
  const tx = await manager.stageInstalledRelease();
  await manager.store.activate();
  await manager.store.healthy(tx.id);
  await manager.store.recover("old");
  await manager.store.update({ workspaceBase: "old", selectedBase: "old" });
  await manager.store.pruneBuilds();
  assert.equal(await exists(join(manager.store.root, "builds", tx.to)), false);
  assert.equal(await manager.installedRelease(), null);
  assert.equal(await manager.stageInstalledRelease(), null);
  assert.equal((await manager.store.read()).active, "old");
});

test("a failed installed release restores the old selection and is not retried at every launch", async (t) => {
  const { manager } = await fixture(t);
  await mkdir(manager.source);
  await writeFile(join(manager.source, "draft.txt"), "retained source");
  const tx = await manager.stageInstalledRelease();
  const result = await runHandoff(manager.store, {
    withLock: action => action(), progress: async () => {},
    launch: async build => build, stop: async () => {},
    waitHealthy: async (build, id) => {
      if (build.id === tx.to) return false;
      await manager.store.healthy(id);
      return true;
    },
  });
  assert.equal(result.recovered, true);
  assert.equal((await manager.store.read()).active, "old");
  assert.equal(await readFile(join(manager.source, "draft.txt"), "utf8"), "retained source");
  assert.equal(await manager.installedRelease(), null);
});

test("local versions and unfinished work retain their complete registry and source", async (t) => {
  const { manager } = await fixture(t);
  const original = await manager.store.read();
  await mkdir(manager.source);
  await writeFile(join(manager.source, "draft.txt"), "unfinished work");
  for (const patch of [
    { builds: [{ ...original.builds[0], kind: "local", savedAt: "2026-09-13" }] },
    { iteration: { base: "old" } },
    { draftDirty: true },
    { candidate: "draft", builds: [...original.builds, { id: "draft", kind: "local" }] },
  ]) {
    await writeJson(manager.store.statePath, { ...original, ...patch });
    const before = await readFile(manager.store.statePath);
    assert.equal(await manager.installedRelease(), null);
    assert.equal(await manager.stageInstalledRelease(), null);
    assert.deepEqual(await readFile(manager.store.statePath), before);
    assert.equal(await readFile(join(manager.source, "draft.txt"), "utf8"), "unfinished work");
  }
});

test("internal retained packages, older installs and development bundles never take over", async (t) => {
  const { manager, resources, metadataPath, metadata } = await fixture(t);
  const external = manager.executable;
  manager.executable = join(manager.store.root, "builds/another", manager.target.bundle, manager.target.executable);
  assert.equal(await manager.installedRelease(), null);
  manager.executable = external;
  for (const changes of [{ version: "0.3.9" }, { version: "0.3.10" }, { platform: "other" }, { evolution_protocol: 1 }, { build_kind: "local" }]) {
    await writeJson(metadataPath, { ...metadata, ...changes });
    assert.equal(await manager.installedRelease(), null);
  }
  await writeJson(metadataPath, metadata);
  assert.equal((await manager.installedRelease()).version, "0.4.0", "Legacy official releases with bundled source must still be recognized");
  await writeJson(metadataPath, { ...metadata, build_kind: "official" });
  assert.equal((await manager.installedRelease()).version, "0.4.0");
});

test("a state change between detection and staging cannot overwrite a new draft", async (t) => {
  const { manager } = await fixture(t);
  assert.ok(await manager.installedRelease());
  await manager.store.update({ draftDirty: true });
  assert.equal(await manager.stageInstalledRelease(), null);
  assert.deepEqual(await readdir(join(manager.store.root, "builds")), ["old"]);
});

test("an existing baseline at the installed version identifies an intentional older selection", async (t) => {
  const { manager } = await fixture(t);
  const state = await manager.store.read();
  await manager.store.update({ baseline: "newer-baseline", builds: [...state.builds,
    { ...state.builds[0], id: "newer-baseline", version: "0.4.0", baseTag: "v0.4.0" }] });
  assert.equal(await manager.installedRelease(), null);
  assert.equal((await manager.store.read()).active, "old");
});

test("a failed journal write can retry the retained package without duplicating it", async (t) => {
  const { manager } = await fixture(t);
  const stage = manager.store.stage.bind(manager.store);
  t.mock.method(manager.store, "stage", async () => { throw new Error("disk unavailable"); });
  await assert.rejects(manager.stageInstalledRelease(), /disk unavailable/);
  const afterFailure = await manager.store.read();
  assert.equal(afterFailure.active, "old");
  assert.equal(afterFailure.transaction, null);
  assert.equal(afterFailure.installedReleases, undefined);
  manager.store.stage = stage;
  await manager.stageInstalledRelease();
  assert.equal((await manager.store.read()).builds.length, afterFailure.builds.length);
});
