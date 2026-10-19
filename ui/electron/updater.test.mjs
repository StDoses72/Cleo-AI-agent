import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compareVersions, DesktopUpdater, validateManifest as validatePlatformManifest } from "./updater.mjs";
import { ReleaseDownloads } from "./release-downloads.mjs";

const validateManifest = (value) => validatePlatformManifest(value, { id: "windows-x64", archive: "Cleo-windows-x64.zip" });

const manifest = {
  schema_version: 1,
  app: "Cleo",
  version: "0.2.0",
  platform: "windows-x64",
  archive: "Cleo-windows-x64.zip",
  sha256: "a".repeat(64),
  bytes: 1024,
};

test("semantic version comparison handles prereleases", () => {
  assert.equal(compareVersions("0.1.3", "0.1.3-alpha"), 1);
  assert.equal(compareVersions("0.1.3-alpha.2", "0.1.3-alpha.10"), -1);
  assert.equal(compareVersions("v1.2.0", "1.1.9"), 1);
  assert.equal(compareVersions("1.0.0+build.2", "1.0.0+build.1"), 0);
});

test("online update archives declare the new schema and dependency preparation protocol", () => {
  assert.equal(validateManifest({ ...manifest, schema_version: 2, evolution_protocol: 3 }).schemaVersion, 2);
  assert.throws(() => validateManifest({ ...manifest, schema_version: 2, evolution_protocol: 2 }), /unexpected/);
});

test("release manifests must describe the expected verified Windows archive", () => {
  assert.equal(validateManifest(manifest).version, "0.2.0");
  assert.throws(
    () => validateManifest({ ...manifest, archive: "other.zip" }),
    /unexpected release metadata/,
  );
  assert.throws(
    () => validateManifest({ ...manifest, sha256: "not-a-hash" }),
    /unexpected release metadata/,
  );
});

test("packaged updater reports a newer release", async () => {
  const states = [];
  const updater = new DesktopUpdater({
    platform: "win32", arch: "x64",
    app: {
      isPackaged: true,
      getVersion: () => "0.1.3-alpha",
      getPath: () => "C:\\Temp",
    },
    resourcesPath: "C:\\Cleo\\resources",
    executablePath: "C:\\Cleo\\Cleo.exe",
    onState: (state) => states.push(state),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => manifest,
    }),
  });

  const state = await updater.check();

  assert.equal(state.phase, "available");
  assert.equal(state.latestVersion, "0.2.0");
  assert.deepEqual(states.map((item) => item.phase), ["checking", "available"]);
});

test("development builds do not contact the release server", async () => {
  let fetched = false;
  const updater = new DesktopUpdater({
    platform: "win32", arch: "x64",
    app: { isPackaged: false, getVersion: () => "0.1.3-alpha" },
    resourcesPath: "",
    fetchImpl: async () => {
      fetched = true;
      throw new Error("unexpected fetch");
    },
  });

  assert.equal((await updater.check()).phase, "unsupported");
  assert.equal(fetched, false);
});

test("downloaded updates reach ready only after size and SHA-256 verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-updater-"));
  const archive = Buffer.from("verified Cleo update");
  const downloadableManifest = {
    ...manifest,
    sha256: createHash("sha256").update(archive).digest("hex"),
    bytes: archive.length,
  };
  let request = 0;
  let archiveUrl = "";
  try {
    const updater = new DesktopUpdater({
    platform: "win32", arch: "x64",
      app: {
        isPackaged: true,
        getVersion: () => "0.1.3-alpha",
        getPath: () => root,
      },
      resourcesPath: root,
      executablePath: "C:\\Cleo\\Cleo.exe",
      fetchImpl: async (url) => {
        request += 1;
        if (request === 1) return { ok: true, status: 200, json: async () => downloadableManifest };
        archiveUrl = String(url);
        return new Response(archive, { status: 200 });
      },
    });

    assert.equal((await updater.check()).phase, "available");
    const state = await updater.download();
    assert.equal(state.phase, "ready");
    assert.equal(state.downloadedBytes, archive.length);
    assert.match(archiveUrl, /releases\/download\/v0\.2\.0\/Cleo-windows-x64\.zip$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a verified download never authorizes installation on the next launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-auto-update-"));
  const archive = Buffer.from("new application");
  const release = { ...manifest, bytes: archive.length,
    sha256: createHash("sha256").update(archive).digest("hex") };
  const app = { isPackaged: true, getVersion: () => "0.1.0", getPath: () => root, quit: () => assert.fail("in-place install") };
  const options = { app, platform: "win32", arch: "x64", resourcesPath: root };
  try {
    const downloading = new DesktopUpdater({ ...options,
      fetchImpl: async (url) => String(url).endsWith(".zip")
        ? new Response(archive) : { ok: true, json: async () => release },
    });
    assert.equal((await downloading.download()).phase, "ready");
    // Installation only ever delegates to the evolution switch; there is no in-place installer to fall back to.
    await assert.rejects(downloading.install(), /未完成版本切换/);
    assert.equal(downloading.getState().phase, "ready");
    const next = new DesktopUpdater(options);
    assert.equal(next.getState().phase, "idle");
    assert.equal(await next.install(async () => true), false, "a fresh process has no verified download");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the updater delegates to the shared cache consumed by version activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-shared-updater-"));
  const archive = Buffer.from("one download for update and activation");
  const raw = { ...manifest, bytes: archive.length, sha256: createHash("sha256").update(archive).digest("hex") };
  let fetched = 0;
  try {
    const downloads = new ReleaseDownloads({ root: join(root, "profile", "evolution", "downloads"),
      fetchImpl: async () => { fetched++; return new Response(archive); },
    });
    const updater = new DesktopUpdater({ app: { isPackaged: true, getVersion: () => "0.1.0", getPath: () => root },
      platform: "win32", arch: "x64", downloads,
      fetchImpl: async () => ({ ok: true, json: async () => raw }),
    });
    const state = await updater.download();
    assert.equal(state.phase, "ready");
    assert.equal(state.downloadedBytes, archive.length);
    const activeArchive = await downloads.get(validateManifest(raw), { url: "https://example.test/release.zip" });
    assert.equal(updater.archivePath, activeArchive);
    assert.equal(updater.archiveFor(validateManifest(raw)), activeArchive);
    assert.equal(fetched, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
