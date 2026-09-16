import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { SelectableUpdater, SelectableProgramUpdates, prepareSelectedRelease } from "../electron/selectable-updates.mjs";
import { EvolutionManager } from "../electron/evolution.mjs";
import { ReleaseDownloads } from "../electron/release-downloads.mjs";
import { desktopPlatform } from "../electron/platform.mjs";

async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), "cleo-select-update-test-"));
  const target = desktopPlatform();
  const payload = Buffer.from("selected package");
  const hooks = {};
  const calls = [];
  const release = (tag, prerelease, assets = true) => ({ tag_name: tag, prerelease, draft: false,
    assets: assets ? [{ name: target.manifest }, { name: target.archive }] : [] });
  const catalog = [release("v0.9.0", false), release("0.8.0-beta.2", true), release("v0.3.0", false), release("v0.2.0", false, false)];
  const manifest = version => ({ schema_version: 1, app: "Cleo", version, platform: target.id,
    evolution_protocol: 2, archive: target.archive, bytes: payload.length, sha256: createHash("sha256").update(payload).digest("hex") });
  const network = async url => {
    calls.push(String(url));
    if (url.includes("/releases?")) { await hooks.catalog?.(); return Response.json(catalog); }
    const tag = decodeURIComponent(new URL(url).pathname.split("/").at(-2));
    if (url.endsWith(target.manifest)) return Response.json({ ...manifest(tag.replace(/^v/, "")), ...hooks.manifest });
    if (url.endsWith(target.archive)) {
      await hooks.download?.();
      return new Response(hooks.corrupt ? "corrupt" : payload);
    }
    throw new Error(`Unexpected ${url}`);
  };
  const app = { isPackaged: true, getVersion: () => "0.6.0", getPath: name => join(root, name) };
  const downloads = new ReleaseDownloads({ root: join(root, "downloads"), fetchImpl: network });
  const updater = new SelectableUpdater({ app, downloads, fetchImpl: network, platform: target.platform });
  const manager = new EvolutionManager({ app, root: join(root, "evolution"), dataHome: join(root, "home"), downloads,
    extractArchive: async (archive, directory) => {
      assert.deepEqual(await readFile(archive), payload);
      const file = join(directory, target.bundle, target.executable);
      await mkdir(dirname(file), { recursive: true }); await writeFile(file, "selected executable");
    } });
  const base = { id: "base", kind: "official", version: "0.6.0", baseTag: "v0.6.0", executable: `${target.bundle}/${target.executable}`, unknownBuild: { retain: true } };
  await mkdir(join(root, "home"));
  await writeFile(join(root, "home", "content.json"), JSON.stringify({ chats: [{ id: "chat", text: "keep" }], memory: ["remember"], config: { model: "chosen" }, unknown: [1, 2] }));
  await manager.store.update({ active: "base", baseline: "base", builds: [base], unknownState: { retain: true } });
  manager.ensureBaseline = async () => base;
  const applied = [];
  const program = new SelectableProgramUpdates({ updater, evolution: manager, hasRunningTask: () => Boolean(hooks.running),
    apply: async id => { applied.push(id); } });
  try { await action({ root, manager, updater, program, hooks, catalog, calls, applied }); }
  finally { program.close(); await manager.close(); await rm(root, { recursive: true, force: true }); }
}

test("catalog includes prereleases, historical versions and platform incompatibility reasons", async () => {
  await fixture(async ({ program, updater }) => {
    await program.check();
    assert.equal(updater.getState().latestVersion, "0.9.0");
    assert.equal(updater.catalog.length, 4);
    assert.equal(updater.catalog[1].prerelease, true);
    assert.match(updater.catalog[3].reason, /平台/);
    await assert.rejects(program.check("v0.2.0"), /平台/);
  });
});

test("simultaneous automatic checks share a request and preserve an explicit version", async () => {
  await fixture(async ({ program, updater, calls, hooks }) => {
    await program.check();
    await program.check("v0.3.0");
    let release;
    hooks.catalog = () => new Promise(resolve => { release = resolve; });
    calls.length = 0;
    const before = Date.now();
    const first = program.check();
    const second = program.check();
    assert.equal(first, second);
    await assert.rejects(program.check("0.8.0-beta.2"), /正在进行/);
    release();
    await first;
    assert.equal(calls.filter(url => url.includes("/releases?")).length, 1);
    assert.equal(updater.getState().selectedTag, "v0.3.0");
    assert(updater.getState().checkedAt >= before);
    assert.equal(program.busy, false);
    assert.equal(updater.getState().operationBusy, false);
  });
});

test("failed automatic checks record an attempt and allow a later retry", async () => {
  await fixture(async ({ program, updater, hooks }) => {
    hooks.catalog = () => { throw new Error("network unavailable"); };
    const before = Date.now();
    assert.equal((await program.check()).phase, "error");
    assert(updater.getState().checkedAt >= before);
    assert.equal(program.busy, false);
    delete hooks.catalog;
    assert.equal((await program.check()).phase, "available");
  });
});

test("background checks retain a verified download until the user chooses another version", async () => {
  await fixture(async ({ program, updater, hooks, calls }) => {
    await program.check();
    await program.download();
    const archive = updater.archivePath;
    const manifest = updater.manifest;
    hooks.catalog = () => { throw new Error("offline"); };
    calls.length = 0;
    assert.equal((await program.check()).phase, "ready");
    assert.equal(updater.archivePath, archive);
    assert.equal(updater.manifest, manifest);
    assert.equal(calls.length, 0);
    delete hooks.catalog;
    assert.equal((await program.check("v0.3.0")).phase, "available");
    assert.equal(updater.getState().latestVersion, "0.3.0");
  });
});

for (const tag of ["0.8.0-beta.2", "v0.3.0"]) test(`${tag} uses its own manifest, asset and cache through installation`, async () => {
  await fixture(async ({ program, updater, calls, manager, applied, root }) => {
    await program.check();
    assert.equal((await program.check(tag)).phase, "available");
    assert.equal((await program.download()).phase, "ready");
    assert(updater.archivePath.includes(tag.replace(/^v/, "")));
    const before = await readFile(join(root, "home", "content.json"));
    await program.install();
    const build = (await manager.store.read()).builds.find(item => item.id === applied[0]);
    assert.equal(build.version, tag.replace(/^v/, "")); assert.equal(build.baseTag, tag);
    assert(calls.some(url => url.includes(`/download/${tag}/${updater.target.manifest}`)));
    const archives = calls.filter(url => url.endsWith(updater.target.archive));
    assert.equal(archives.length, 1, "Install must reuse and reverify the version-specific archive");
    assert(archives[0].includes(`/download/${tag}/`));
    assert.deepEqual(await readFile(join(root, "home", "content.json")), before);
    assert.equal((await manager.store.read()).active, "base");
  });
});

test("changing selection invalidates downloaded state; install can only use the final selection", async () => {
  await fixture(async ({ program, updater, applied, manager }) => {
    await program.download();
    assert.equal(updater.getState().phase, "ready");
    await program.check("0.8.0-beta.2");
    assert.equal(updater.archivePath, null);
    await assert.rejects(program.install(), /下载并校验/);
    assert.equal(applied.length, 0);
    await program.download(); await program.install();
    assert.equal((await manager.store.read()).builds.find(item => item.id === applied[0]).version, "0.8.0-beta.2");
  });
});

test("an explicit current-version selection can restore an official package over local program changes", async () => {
  await fixture(async ({ program, catalog, updater, applied }) => {
    catalog.push({ tag_name: "v0.6.0", prerelease: false, assets: [{ name: updater.target.manifest }, { name: updater.target.archive }] });
    await program.check();
    assert.equal((await program.check("v0.6.0")).phase, "available");
    await program.download(); await program.install();
    assert.equal(applied.length, 1);
  });
});

test("selecting the already-active verified build finishes without leaving an installing state", async () => {
  await fixture(async ({ program, manager, updater }) => {
    await program.download();
    const id = await prepareSelectedRelease(manager, updater, "v0.9.0");
    await manager.store.update({ active: id });
    await program.install();
    assert.equal(updater.getState().phase, "updated");
  });
});

for (const failure of ["version", "protocol", "checksum", "size"]) test(`${failure} mismatch cannot become installable`, async () => {
  await fixture(async ({ program, hooks, applied }) => {
    if (failure === "version") hooks.manifest = { version: "9.9.9" };
    if (failure === "protocol") hooks.manifest = { evolution_protocol: 1 };
    if (failure === "checksum") hooks.manifest = { sha256: "0".repeat(64) };
    if (failure === "size") hooks.corrupt = true;
    assert.equal((await program.download()).phase, "error");
    await assert.rejects(program.install(), /下载并校验/);
    assert.deepEqual(applied, []);
  });
});

test("running tasks and unfinished iterations retain the existing activation guards", async () => {
  await fixture(async ({ program, hooks, manager, applied }) => {
    await program.download();
    hooks.running = true;
    await assert.rejects(program.install(), /当前任务/);
    hooks.running = false;
    await manager.store.update({ iteration: { base: "base" } });
    await assert.rejects(program.install(), /保存或放弃/);
    assert.equal(applied.length, 0);
  });
});

test("selection cannot race an in-progress download", async () => {
  await fixture(async ({ program, hooks, updater }) => {
    await program.check();
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    hooks.download = async () => { entered.resolve(); await release.promise; };
    const downloading = program.download();
    try {
      await entered.promise;
      await assert.rejects(program.check("v0.3.0"), /另一项版本操作/);
      assert.equal(updater.checkedRelease.tag, "v0.9.0");
    } finally { release.resolve(); await downloading; }
  });
});

test("existing registry format round-trips through the iteration-base writer without losing unknown fields or user data", async () => {
  await fixture(async ({ program, manager, root }) => {
    const source = execFileSync("git", ["show", "HEAD:ui/electron/evolution-store.mjs"], { encoding: "utf8", windowsHide: true });
    const legacyFile = join(root, "iteration-base-store.mjs");
    await writeFile(legacyFile, source);
    const { EvolutionStore: PreviousStore } = await import(pathToFileURL(legacyFile).href);
    const previous = new PreviousStore(manager.store.root, manager.store.dataHome);
    await previous.update({ legacyOptionalMissing: true });
    const userBefore = await readFile(join(root, "home", "content.json"));
    await program.check(); await program.check("0.8.0-beta.2"); await program.download(); await program.install();
    const before = await manager.store.read();
    assert.equal(before.unknownState.retain, true);
    assert.equal(before.builds[0].unknownBuild.retain, true);
    await previous.update({ threadId: "old-writer-thread" });
    const after = await manager.store.read();
    assert.deepEqual(after, { ...before, threadId: "old-writer-thread" });
    assert.deepEqual(await readFile(join(root, "home", "content.json")), userBefore);
  });
});

test("available saved and baseline program writers preserve the same registry fields", { skip: !process.env.CLEO_COMPAT_BUILDS }, async () => {
  const { extractFile } = await import("@electron/asar");
  const buildsRoot = process.env.CLEO_COMPAT_BUILDS;
  const directories = await readdir(buildsRoot, { withFileTypes: true });
  let checked = 0;
  for (const entry of directories.filter(item => item.isDirectory())) {
    const archive = join(buildsRoot, entry.name, "Cleo/resources/app.asar");
    const source = extractFile(archive, "electron/evolution-store.mjs");
    await fixture(async ({ root, manager, program }) => {
      const file = join(root, "previous-store.mjs");
      await writeFile(file, source);
      const { EvolutionStore: PreviousStore } = await import(pathToFileURL(file).href);
      const previous = new PreviousStore(manager.store.root, manager.store.dataHome);
      await previous.update({ threadId: "previous-thread" });
      const dataBefore = await readFile(join(root, "home", "content.json"));
      await program.check(); await program.check("0.8.0-beta.2"); await program.download(); await program.install();
      const before = await manager.store.read();
      await previous.update({ threadId: "previous-writer-update" });
      assert.deepEqual(await manager.store.read(), { ...before, threadId: "previous-writer-update" }, entry.name);
      assert.deepEqual(await readFile(join(root, "home", "content.json")), dataBefore, entry.name);
    });
    checked++;
  }
  assert(checked > 0, "No saved/baseline programs were checked");
  console.log(`Compatibility verified against ${checked} available program writers`);
});
