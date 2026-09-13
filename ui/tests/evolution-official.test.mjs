import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { EvolutionManager } from "../electron/evolution.mjs";
import { exists, writeJson } from "../electron/evolution-store.mjs";
import { ReleaseDownloads } from "../electron/release-downloads.mjs";

async function fixture(t, { draft = false } = {}) {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, "cleo-official-test-"));
  const body = Buffer.from("checksum-verified archive fixture");
  const count = { fetch: 0, extract: 0 };
  const downloads = new ReleaseDownloads({ root: join(root, "downloads"), fetchImpl: async () => {
    count.fetch++;
    return new Response(body);
  } });
  const manager = new EvolutionManager({ app: { isPackaged: false, getVersion: () => "0.3.11" },
    root: join(root, "evolution"), dataHome: join(root, "home"), downloads,
    extractArchive: async (archive, directory, { signal }) => {
      signal.throwIfAborted();
      assert.deepEqual(await readFile(archive), body);
      count.extract++;
      const executable = join(directory, manager.target.bundle, manager.target.executable);
      await mkdir(dirname(executable), { recursive: true });
      await writeFile(executable, "verified official executable");
    },
  });
  t.after(async () => {
    await manager.close();
    assert.equal(dirname(root), parent);
    await rm(root, { recursive: true, force: true });
  });
  const manifest = { schema_version: 1, app: "Cleo", version: "0.4.0", platform: manager.target.id,
    archive: manager.target.archive, sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length, evolution_protocol: 2 };
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(manifest)));
  const builds = [{ id: "base", kind: "official", version: "0.3.11", baseTag: "v0.3.11" },
    ...(draft ? [{ id: "draft", kind: "local", sourceHash: "old-draft-hash" }] : [])];
  for (const build of builds) {
    build.executable = `${manager.target.bundle}/${manager.target.executable}`;
    const executable = join(manager.store.root, "builds", build.id, build.executable);
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, build.id);
  }
  await mkdir(join(manager.source, ".git"), { recursive: true });
  await writeFile(join(manager.source, "original.txt"), "original source and local work");
  await mkdir(join(manager.store.dataHome, "data"), { recursive: true });
  await writeFile(join(manager.store.dataHome, "data/messages.txt"), "latest conversation");
  await manager.store.update({ active: "base", baseline: "base", selectedBase: "base", workspaceBase: "base", builds,
    baseTag: "v0.3.11", prepared: true, threadId: "editing-thread", baseSourceHash: "old-base-hash",
    iteration: draft ? { base: "base" } : null, candidate: draft ? "draft" : null, draftDirty: false });
  await writeJson(join(manager.store.root, "validation.json"), { status: "passed", candidate: "draft", sourceHash: "old-draft-hash" });
  await writeJson(join(manager.store.root, "releases.json"), [{ tag: "v0.4.0", manifestUrl: "https://example.test/release.json" }]);
  return { root, manager, count, manifest };
}

test("official preparation preserves the local candidate and reuses a verified extracted build", async (t) => {
  const { manager, count } = await fixture(t, { draft: true });
  const validation = await readFile(join(manager.store.root, "validation.json"));
  const progress = [];
  const id = await manager.downloadRelease("v0.4.0", { onProgress: (...values) => progress.push(values) });
  const state = await manager.store.read();
  assert.equal(state.candidate, "draft");
  assert.equal(state.downloadedOfficial, id);
  assert.deepEqual(state.iteration, { base: "base" });
  assert.equal(state.prepared, true);
  assert.equal(state.baseTag, "v0.3.11");
  assert.deepEqual(await readFile(join(manager.store.root, "validation.json")), validation);
  assert.equal(await readFile(join(manager.source, "original.txt"), "utf8"), "original source and local work");
  await manager.store.pruneBuilds();
  await manager.store.build("draft");
  await manager.store.build(id);
  assert.equal(await manager.downloadRelease("v0.4.0"), id);
  assert.deepEqual(count, { fetch: 1, extract: 1 });
  assert.equal((await readdir(join(manager.store.root, "builds"))).filter(name => name.startsWith("official-")).length, 1);
  assert(progress.some(([bytes, total]) => bytes > 0 && bytes === total));
});

test("failed extraction removes only its own incomplete directory and leaves the draft intact", async (t) => {
  const { manager, count } = await fixture(t, { draft: true });
  const extract = manager.extractArchive;
  manager.extractArchive = async (_archive, directory) => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "partial"), "incomplete");
    throw new Error("fixture extraction failed");
  };
  await assert.rejects(manager.downloadRelease("v0.4.0"), /extraction failed/);
  const state = await manager.store.read();
  assert.equal(state.candidate, "draft");
  assert.equal(state.downloadedOfficial, undefined);
  assert.deepEqual((await readdir(join(manager.store.root, "builds"))).sort(), ["base", "draft"]);
  manager.extractArchive = extract;
  await manager.downloadRelease("v0.4.0");
  assert.equal(count.fetch, 1, "Retry should reuse the checksum-verified download");
});

test("all unfinished-local-work states block official switching at both entry and stage", async (t) => {
  const { manager } = await fixture(t, { draft: true });
  const id = await manager.downloadRelease("v0.4.0");
  for (const patch of [
    { iteration: { base: "base" }, draftDirty: false, candidate: null },
    { iteration: null, draftDirty: true, candidate: null },
    { iteration: null, draftDirty: false, candidate: "draft" },
  ]) {
    await manager.store.update(patch);
    await assert.rejects(manager.assertOfficialSwitchAllowed(), /保存或放弃/);
    await assert.rejects(manager.stage(id), /保存或放弃/);
    assert.equal((await manager.store.read()).transaction, null);
  }
});

test("legacy official-source mismatch preserves unfinished local work before preparing any tools", async (t) => {
  const { manager } = await fixture(t, { draft: true });
  const id = await manager.downloadRelease("v0.4.0");
  // The older controller changed active, then completed a journal without source-selection metadata.
  await manager.store.update({ active: id });
  const before = await manager.store.read();
  manager.tools.prepare = async () => { assert.fail("Unfinished source must be rejected before tool preparation"); };
  await assert.rejects(manager.prepare(), /保存或放弃/);
  assert.deepEqual(await manager.store.read(), before);
  assert.equal(await readFile(join(manager.source, "original.txt"), "utf8"), "original source and local work");
  assert.deepEqual((await readdir(manager.store.root)).filter(name => name.startsWith("source-history-")), []);
});

test("clean legacy official-source mismatch archives the old source and retries from the new tag", async (t) => {
  const { manager, root } = await fixture(t);
  const id = await manager.downloadRelease("v0.4.0");
  await manager.store.update({ active: id });
  manager.tools.prepare = async () => { throw new Error("fixture tool preparation failure"); };
  await assert.rejects(manager.prepare(), /tool preparation failure/);
  const state = await manager.store.read();
  assert.equal(state.prepared, false);
  assert.equal(state.baseTag, "v0.4.0");
  assert.equal(state.selectedBase, id);
  assert.equal(state.workspaceBase, id);
  assert.equal(state.threadId, null);
  assert.equal(state.baseSourceHash, null);
  assert.equal(await exists(manager.source), false);
  const archives = (await readdir(manager.store.root)).filter(name => name.startsWith("source-history-"));
  assert.equal(archives.length, 1);
  assert.equal(await readFile(join(manager.store.root, archives[0], "original.txt"), "utf8"), "original source and local work");
  // An absent local executable stops clone before any network access, after the new tag is selected.
  manager.tools.prepare = async () => ({ git: join(root, "nonexistent-fixture-git"), env: process.env });
  await assert.rejects(manager.prepare(), { code: "ENOENT" });
  assert.match(manager.logs, /正在获取 v0\.4\.0 的源码/);
  assert.deepEqual((await readdir(manager.store.root)).filter(name => name.startsWith("source-history-")), archives);
  assert.equal((await manager.store.read()).prepared, false);
});

test("an official switch prepares a recoverable source baseline after the old app stops", async (t) => {
  const { manager } = await fixture(t);
  const id = await manager.downloadRelease("v0.4.0");
  assert.equal(await manager.selectVersion(id), id);
  assert(await exists(manager.source), "Selection must not archive source while the old app is still running");
  const tx = await manager.stage(id);
  assert.equal((await manager.store.read()).baseTag, "v0.3.11");
  await assert.rejects(manager.operation("building", async () => {}), /版本正在切换/);
  await manager.store.activate();
  assert.equal((await manager.store.read()).prepared, false);
  assert.equal((await manager.store.read()).transaction.phase, "starting");
  await manager.store.healthy(tx.id);
  const state = await manager.store.read();
  assert.equal(state.active, id);
  assert.equal(state.selectedBase, id);
  assert.equal(state.workspaceBase, id);
  assert.equal(state.baseTag, "v0.4.0");
  assert.equal(state.prepared, false);
  assert.equal(state.baseSourceHash, null);
  assert.equal(state.threadId, null);
  assert.equal(state.transaction, null);
  assert.equal(state.iteration, null);
  assert.equal(state.candidate, null);
  assert.equal(await exists(manager.source), false);
  assert.equal(await readFile(join(manager.store.root, tx.officialSelection.sourceArchive, "original.txt"), "utf8"), "original source and local work");
  assert.equal(await readFile(join(manager.store.dataHome, "data/messages.txt"), "utf8"), "latest conversation");
});

test("failed official startup cancels selection intent without changing the original source baseline", async (t) => {
  const { manager } = await fixture(t);
  const id = await manager.downloadRelease("v0.4.0");
  await manager.stage(id);
  await manager.store.activate();
  await manager.store.recover("base");
  const state = await manager.store.read();
  assert.equal(state.active, "base");
  assert.equal(state.baseTag, "v0.3.11");
  assert.equal(state.prepared, true);
  assert.equal(state.threadId, "editing-thread");
  assert.equal(state.baseSourceHash, "old-base-hash");
  assert.equal(state.transaction, null);
  assert.equal(await readFile(join(manager.source, "original.txt"), "utf8"), "original source and local work");
});

for (const outcome of ["recover", "retry"]) {
  test(`interrupted official source archiving can ${outcome} without losing the original source`, async (t) => {
    const { manager } = await fixture(t);
    const id = await manager.downloadRelease("v0.4.0");
    const tx = await manager.stage(id);
    const update = manager.store.update.bind(manager.store);
    const failure = t.mock.method(manager.store, "update", async patch => {
      if (patch.active === id && patch.prepared === false) throw new Error("fixture journal write failed");
      return update(patch);
    });
    await assert.rejects(manager.store.activate(), /journal write failed/);
    assert.equal(await exists(manager.source), false);
    assert.equal((await manager.store.read()).transaction.id, tx.id);
    failure.mock.restore();
    if (outcome === "recover") {
      await manager.store.recover("base");
      assert.equal(await readFile(join(manager.source, "original.txt"), "utf8"), "original source and local work");
      assert.equal((await manager.store.read()).baseTag, "v0.3.11");
    } else {
      await manager.store.activate();
      await manager.store.healthy(tx.id);
      assert.equal(await readFile(join(manager.store.root, tx.officialSelection.sourceArchive, "original.txt"), "utf8"), "original source and local work");
      assert.equal((await manager.store.read()).baseTag, "v0.4.0");
    }
    assert.equal((await manager.store.read()).transaction, null);
  });
}

test("an older protocol-2 target can complete its journal without knowing official selection fields", async (t) => {
  const { manager } = await fixture(t);
  const id = await manager.downloadRelease("v0.4.0");
  const tx = await manager.stage(id);
  await manager.store.activate();
  const state = await manager.store.read();
  // This is the published protocol-2 healthy acknowledgment before selection intents existed.
  await manager.store.update({ lastApplication: state.transaction, transaction: null });
  await manager.store.pruneBuilds();
  const completed = await manager.store.read();
  assert.equal(completed.baseTag, "v0.4.0");
  assert.equal(completed.prepared, false);
  assert.equal(completed.selectedBase, id);
  assert.equal(completed.lastApplication.id, tx.id);
  assert.equal(await exists(manager.source), false);
  assert.equal(await readFile(join(manager.store.root, tx.officialSelection.sourceArchive, "original.txt"), "utf8"), "original source and local work");
});

test("conflicting source and archive directories fail closed without overwriting either copy", async (t) => {
  const { manager } = await fixture(t);
  const id = await manager.downloadRelease("v0.4.0");
  const tx = await manager.stage(id);
  const archived = join(manager.store.root, tx.officialSelection.sourceArchive);
  await mkdir(archived);
  await writeFile(join(archived, "original.txt"), "other preserved source");
  await assert.rejects(manager.store.activate(), /源码归档已存在/);
  await assert.rejects(manager.store.recover("base"), /同时存在/);
  assert.equal(await readFile(join(manager.source, "original.txt"), "utf8"), "original source and local work");
  assert.equal(await readFile(join(archived, "original.txt"), "utf8"), "other preserved source");
  assert.equal((await manager.store.read()).active, "base");
  assert.equal((await manager.store.read()).baseTag, "v0.3.11");
});

test("close aborts and waits for extraction cleanup before allowing the old process to exit", async (t) => {
  const { manager } = await fixture(t, { draft: true });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let stopped = false;
  manager.extractArchive = async (_archive, directory, { signal }) => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "partial"), "incomplete");
    started();
    try {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } finally { stopped = true; }
  };
  const operation = manager.downloadRelease("v0.4.0");
  const rejected = assert.rejects(operation, /退出/);
  await ready;
  await manager.close();
  await rejected;
  assert(stopped);
  assert.deepEqual((await readdir(join(manager.store.root, "builds"))).sort(), ["base", "draft"]);
  assert.equal((await manager.store.read()).candidate, "draft");
  await assert.rejects(manager.operation("building", async () => {}), /正在退出/);
});

test("close terminates a running operation command and waits for its exit", async (t) => {
  const { manager } = await fixture(t);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const operation = manager.operation("building", () => manager.runCommand(process.execPath,
    ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { log: () => started() }));
  const rejected = assert.rejects(operation, /退出/);
  await ready;
  await manager.close();
  await rejected;
  assert.equal(manager.phase, "idle");
});
