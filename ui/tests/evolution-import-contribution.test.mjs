import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { EvolutionManager, developmentBundleDigest } from "../electron/evolution.mjs";
import { run } from "../electron/evolution-tools.mjs";
import { writeJson } from "../electron/evolution-store.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cleo-import-contribution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "origin");
  await mkdir(join(repository, "ui"), { recursive: true });
  await cp(new URL("../electron", import.meta.url), join(repository, "ui/electron"), { recursive: true });
  await writeJson(join(repository, "ui/package.json"), { main: "electron/bootstrap.mjs" });
  await writeFile(join(repository, "feature.txt"), "baseline");
  const options = { cwd: repository };
  await run("git", ["init"], options);
  await run("git", ["add", "."], options);
  await run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"], options);
  await run("git", ["tag", "v0.4.5"], options);
  const manager = new EvolutionManager({ app: { isPackaged: false, getVersion: () => "0.4.5" },
    root: join(root, "evolution"), dataHome: join(root, "home"), sourceRepository: repository });
  manager.ensureBaseline = async () => {};
  manager.tools.prepare = async () => ({ git: "git", env: process.env });
  const resources = join(manager.store.root, "builds/imported", manager.target.bundle, manager.target.resources);
  await mkdir(resources, { recursive: true });
  const executable = `${manager.target.bundle}/${manager.target.executable}`;
  await mkdir(dirname(join(manager.store.root, "builds/imported", executable)), { recursive: true });
  await writeFile(join(manager.store.root, "builds/imported", executable), "fixture executable");
  await writeFile(join(resources, "app.asar"), "fixture application");
  const embedded = join(root, "embedded");
  await mkdir(embedded);
  await writeFile(join(embedded, "feature.txt"), "imported feature");
  await writeJson(join(embedded, "evolution-source.json"), { schema: 1, deleted: [] });
  await run("tar", ["-czf", join(resources, "evolution-source.tar.gz"), "-C", embedded, "."]);
  const importHash = await developmentBundleDigest(resources, { readFile });
  await manager.store.update({ active: "imported", baseline: "imported", prepared: false,
    builds: [{ id: "imported", kind: "local", savedAt: "today", baseTag: "v0.4.5", importHash, executable }] });
  return { manager, resources };
}

test("preparing an imported bundle registers its actual source without fabricating a build receipt", async t => {
  const { manager } = await fixture(t);
  await manager.prepare();
  const state = await manager.store.read();
  const build = state.builds.find(b => b.id === state.active);
  assert.equal(await readFile(join(manager.source, "feature.txt"), "utf8"), "imported feature");
  assert.equal(build.sourceHash, await manager.sourceHash({ git: "git", env: process.env }));
  assert.match(build.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(state.candidate ?? null, null);
  assert.equal(state.iteration ?? null, null);
  assert.notEqual((await manager.status()).validation?.status, "passed");
});

test("importing a new program does not inherit the previous workspace dirty marker", async t => {
  const { manager } = await fixture(t);
  await manager.prepare();
  await manager.store.update({ draftDirty: true, iteration: { base: "imported" } });
  manager.executable = (await manager.store.build("imported")).executable;
  const imported = await manager.importBundle();
  const state = await manager.store.read();
  assert.notEqual(imported.id, "imported");
  assert.equal(state.iteration, null);
  assert.equal(state.draftDirty, false);
});

test("preparing an unchanged imported source repairs a legacy orphan dirty flag", async t => {
  const { manager } = await fixture(t);
  await manager.store.update({ draftDirty: true });
  await manager.prepare();
  assert.equal((await manager.store.read()).draftDirty, false);
  await manager.store.update({ draftDirty: true });
  await manager.prepare();
  assert.equal((await manager.store.read()).draftDirty, false);
  await writeFile(join(manager.source, "feature.txt"), "user edits");
  await manager.store.update({ draftDirty: true });
  await manager.prepare();
  assert.equal((await manager.store.read()).draftDirty, true);
});

test("legacy prepared import is registered from the bundle, not from edited working files", async t => {
  const { manager } = await fixture(t);
  await manager.prepare();
  const digest = await manager.sourceHash({ git: "git", env: process.env });
  const state = await manager.store.read();
  await manager.store.update({ builds: state.builds.map(b => ({ ...b, sourceHash: undefined })) });
  await writeFile(join(manager.source, "feature.txt"), "user edits must remain");
  await manager.prepare();
  assert.equal((await manager.store.read()).builds[0].sourceHash, digest);
  assert.equal(await readFile(join(manager.source, "feature.txt"), "utf8"), "user edits must remain");
  assert.notEqual(await manager.sourceHash({ git: "git", env: process.env }), digest);
});

test("changed imported bundle identity cannot register a source fingerprint", async t => {
  const { manager, resources } = await fixture(t);
  await writeFile(join(resources, "app.asar"), "changed after import");
  await assert.rejects(manager.prepare(), /导入.*校验|导入.*变化/);
  assert.equal((await manager.store.read()).builds[0].sourceHash, undefined);
});

test("an imported bundle without source cannot silently substitute official source", async t => {
  const { manager, resources } = await fixture(t);
  await rm(join(resources, "evolution-source.tar.gz"));
  await assert.rejects(manager.prepare(), /源码|校验/);
  assert.equal((await manager.store.read()).builds[0].sourceHash, undefined);
});
