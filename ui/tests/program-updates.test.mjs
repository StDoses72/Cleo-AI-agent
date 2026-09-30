import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { EvolutionManager } from "../electron/evolution.mjs";
import { desktopPlatform } from "../electron/platform.mjs";
import { ProgramUpdates } from "../electron/program-updates.mjs";
import { ReleaseDownloads } from "../electron/release-downloads.mjs";
import { DesktopUpdater, validateManifest } from "../electron/updater.mjs";

async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), "cleo-program-updates-"));
  const previousFetch = globalThis.fetch;
  const target = desktopPlatform();
  const payload = Buffer.from("verified official package fixture");
  const manifest = { schema_version: 1, app: "Cleo", version: "0.4.0", evolution_protocol: 2,
    platform: target.id, archive: target.archive, bytes: payload.length,
    sha256: createHash("sha256").update(payload).digest("hex") };
  const manifestUrl = `https://example.test/${target.manifest}`;
  const hooks = {};
  const counters = { archives: 0, manifests: 0, releases: 0, extracts: 0, applies: 0 };
  const pending = [];
  const barriers = [];
  let manager;
  let downloads;
  let program;
  try {
    const network = async (url, options = {}) => {
      const value = String(url);
      if (value.includes("/releases?")) {
        counters.releases++;
        await hooks.releases?.(options.signal);
        return new Response(JSON.stringify([{ tag_name: "v0.4.0", draft: false, prerelease: false,
          assets: [{ name: target.manifest, browser_download_url: manifestUrl }],
        }]));
      }
      if (value.endsWith(`/${target.manifest}`)) {
        counters.manifests++;
        await hooks.manifest?.(options.signal);
        return new Response(JSON.stringify(manifest));
      }
      if (value.endsWith(`/${target.archive}`)) {
        counters.archives++;
        await hooks.archive?.(options.signal);
        return new Response(payload);
      }
      throw new Error(`Unexpected fixture URL: ${value}`);
    };
    globalThis.fetch = network;
    const dataHome = join(root, "home");
    const controllerRoot = join(root, "profile", "evolution");
    downloads = new ReleaseDownloads({ root: join(controllerRoot, "downloads"), fetchImpl: network });
    const app = { isPackaged: true, getVersion: () => "0.3.11", getPath: name => join(root, name) };
    manager = new EvolutionManager({ app, root: controllerRoot, dataHome, downloads,
      extractArchive: async (archive, directory, { signal }) => {
        signal.throwIfAborted();
        assert.deepEqual(await readFile(archive), payload, "Extraction must only receive the verified artifact");
        counters.extracts++;
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "partial-extract.txt"), "incomplete extraction");
        await hooks.extract?.(signal);
        const executable = join(directory, target.bundle, target.executable);
        await mkdir(dirname(executable), { recursive: true });
        await writeFile(executable, "new official executable");
      },
    });
    const base = { id: "base", kind: "official", version: "0.3.11", baseTag: "v0.3.11",
      executable: `${target.bundle}/${target.executable}` };
    const oldExecutable = join(controllerRoot, "builds", base.id, base.executable);
    await mkdir(dirname(oldExecutable), { recursive: true });
    await writeFile(oldExecutable, "current official executable");
    await mkdir(manager.source, { recursive: true });
    await writeFile(join(manager.source, "user-edit.txt"), "keep source");
    await mkdir(dataHome, { recursive: true });
    await writeFile(join(dataHome, "user-data.txt"), "keep user data");
    await manager.store.update({ active: "base", baseline: "base", selectedBase: "base", workspaceBase: "base",
      baseTag: "v0.3.11", builds: [base], prepared: true, draftDirty: false, iteration: null, candidate: null });
    const updater = new DesktopUpdater({ app, platform: target.platform, arch: process.arch,
      downloads, fetchImpl: network, manifestUrl,
    });
    program = new ProgramUpdates({ updater, evolution: manager, hasRunningTask: () => Boolean(hooks.running),
      apply: async id => {
        counters.applies++;
        await hooks.stage?.(id);
        const transaction = await manager.stage(id);
        try {
          // This is the production apply boundary: stage first, wait for the controller,
          // and clear only the transaction if the controller fails to start.
          await hooks.ready?.(transaction);
        } catch (error) {
          await manager.store.update({ transaction: null });
          throw error;
        }
        program.beginRestart();
        return true;
      },
    });
    const barrier = () => {
      const entered = Promise.withResolvers(), release = Promise.withResolvers();
      barriers.push(release);
      return { entered: entered.promise, release: release.resolve, wait: async () => {
        entered.resolve();
        await release.promise;
      } };
    };
    const install = () => {
      const result = program.install();
      result.catch(() => {}); // Cleanup also observes rejected operations if an assertion fails early.
      pending.push(result);
      return result;
    };
    await action({ root, manager, downloads, updater, program, hooks, counters, manifest, payload,
      archive: downloads.pathFor(validateManifest(manifest, target)), barrier, install });
  } finally {
    for (const barrier of barriers) barrier.resolve();
    await Promise.allSettled(pending);
    program?.close();
    await manager?.close();
    await downloads?.close();
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
}

test("normal download and install share one archive and block evolution through controller readiness", async () => {
  await fixture(async ({ manager, updater, program, hooks, counters, payload, archive, barrier, install }) => {
    assert.equal((await program.download()).phase, "ready");
    assert.equal(counters.archives, 1);
    const releases = barrier(), extracting = barrier(), staging = barrier(), ready = barrier();
    hooks.releases = releases.wait;
    hooks.extract = extracting.wait;
    hooks.stage = staging.wait;
    hooks.ready = ready.wait;
    const first = install();
    assert.equal(updater.getState().phase, "installing", "Install must change state before its first asynchronous check");
    assert.equal(updater.getState().operationBusy, true);
    assert.equal(program.install(), first, "Repeated clicks must join the same installation");
    for (const checkpoint of [releases, extracting, staging, ready]) {
      await checkpoint.entered;
      assert.equal(updater.getState().phase, "installing");
      await assert.rejects(program.run(() => manager.begin()), /另一项版本操作/);
      assert.equal(program.install(), first);
      checkpoint.release();
    }
    assert.equal(await first, true);
    assert.equal(counters.archives, 1, "Installation downloaded the already verified package a second time");
    assert.equal(counters.extracts, 1);
    assert.equal(counters.applies, 1);
    assert.equal(updater.getState().operationBusy, true, "Restart must keep the gate closed after apply returns");
    await assert.rejects(program.run(() => manager.begin()), /另一项版本操作/);
    assert.deepEqual(await readFile(archive), payload);
    const state = await manager.store.read();
    assert.equal(state.transaction.phase, "staged");
    assert.equal(state.active, "base", "Only the external controller may switch the running program");
  });
});

for (const condition of ["iteration", "local-candidate", "dirty-source"]) {
  test(`${condition} blocks installation before preparation and preserves the registry, cache and builds`, async () => {
    await fixture(async ({ root, manager, updater, program, counters, payload, archive, install }) => {
      await program.download();
      const local = { id: "local-draft", kind: "local", executable: `${manager.target.bundle}/${manager.target.executable}` };
      const executable = join(manager.store.root, "builds", local.id, local.executable);
      await mkdir(dirname(executable), { recursive: true });
      await writeFile(executable, "unfinished local executable");
      const current = await manager.store.read();
      await manager.store.update({ builds: [...current.builds, local],
        ...(condition === "iteration" ? { iteration: { base: "base" } }
          : condition === "local-candidate" ? { candidate: local.id } : { draftDirty: true }),
      });
      const before = await manager.store.read();
      await assert.rejects(install(), /保存或放弃/);
      assert.equal(counters.releases, 0);
      assert.equal(counters.extracts, 0);
      assert.equal(counters.applies, 0);
      assert.equal(updater.getState().phase, "ready");
      assert.equal(updater.getState().operationBusy, false);
      assert.deepEqual(await manager.store.read(), before);
      assert.deepEqual(await readFile(archive), payload);
      assert.equal(await readFile(executable, "utf8"), "unfinished local executable");
      assert.equal(await readFile(join(manager.source, "user-edit.txt"), "utf8"), "keep source");
      assert.equal(await readFile(join(root, "home", "user-data.txt"), "utf8"), "keep user data");
    });
  });
}

for (const failure of ["network", "extraction", "controller-start"]) {
  test(`${failure} failure restores ready and retries using the same verified archive`, async () => {
    await fixture(async ({ manager, updater, program, hooks, counters, archive, payload, install }) => {
      await program.download();
      const hook = failure === "network" ? "releases" : failure === "extraction" ? "extract" : "ready";
      hooks[hook] = async () => { throw new Error(`${failure} fixture failure`); };
      await assert.rejects(install(), new RegExp(`${failure} fixture failure`));
      assert.equal(updater.getState().phase, "ready");
      assert.equal(updater.getState().operationBusy, false);
      assert.match(updater.getState().error, /fixture failure/);
      assert.equal((await manager.store.read()).active, "base");
      assert.equal((await manager.store.read()).transaction, null);
      assert.deepEqual(await readFile(archive), payload);
      if (failure === "extraction") {
        assert.deepEqual(await readdir(join(manager.store.root, "builds")), ["base"], "Failed extraction must remove its partial build");
      }
      delete hooks[hook];
      assert.equal(await install(), true);
      assert.equal(counters.archives, 1, "Retry unnecessarily downloaded the verified cache again");
      assert.equal(counters.extracts, failure === "extraction" ? 2 : 1,
        "A prepared official build should be reused after a controller startup failure");
    });
  });
}

test("ordinary downloads serialize with evolution and repeated download clicks join one request", async () => {
  await fixture(async ({ manager, program, hooks, counters, barrier }) => {
    const network = barrier();
    hooks.archive = network.wait;
    const first = program.download();
    try {
      assert.equal(program.download(), first);
      await network.entered;
      await assert.rejects(program.run(() => manager.begin()), /另一项版本操作/);
    } finally { network.release(); }
    assert.equal((await first).phase, "ready");
    assert.equal(counters.archives, 1);
  });
});

test("a running chat blocks activation but still permits a verified download", async () => {
  await fixture(async ({ program, hooks, counters, install }) => {
    hooks.running = true;
    assert.equal((await program.download()).phase, "ready");
    await assert.rejects(install(), /当前任务完成或停止/);
    assert.equal(counters.releases, 0);
    assert.equal(counters.applies, 0);
  });
});

test("checking the same release retains its verified ready state", async () => {
  await fixture(async ({ program, counters, payload }) => {
    await program.download();
    const refreshed = await program.check();
    assert.equal(refreshed.phase, "ready");
    assert.equal(refreshed.downloadedBytes, payload.length);
    assert.equal(counters.archives, 1);
  });
});

test("closing the coordinator prevents any new update, install or evolution operation", async () => {
  await fixture(async ({ manager, updater, program, counters, install }) => {
    await program.download();
    const before = { ...counters };
    program.close();
    await program.check();
    await assert.rejects(program.download(), /另一项版本操作/);
    await assert.rejects(install(), /另一项版本操作/);
    await assert.rejects(program.run(() => manager.begin()), /另一项版本操作/);
    assert.deepEqual(counters, before);
    assert.equal(updater.getState().phase, "ready");
  });
});
