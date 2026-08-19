import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compareVersions, DesktopUpdater, validateManifest } from "./updater.mjs";

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
