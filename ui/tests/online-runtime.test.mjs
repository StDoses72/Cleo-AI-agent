import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { findInstalledRuntime, installRuntime, readRuntimePlan } from "../electron/online-runtime.mjs";
import { desktopPlatform } from "../electron/platform.mjs";

const hash = data => createHash("sha256").update(data).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cleo-online-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = join(root, "app");
  await mkdir(join(resources, "runtime"), { recursive: true });
  const files = {};
  for (const name of ["requirements.txt", "package.json", "package-lock.json", "cleo.whl"]) {
    await writeFile(join(resources, "runtime", name), "fixture");
    files[name] = hash("fixture");
  }
  const artifact = { archive: "python.tar.gz", url: "https://example.test/python.tar.gz",
    version: "3.12.13", sha256: hash("archive"), bytes: 7 };
  const plan = { schema: 1, platform: desktopPlatform().id, version: "0.6.1", files,
    wheel: { archive: "cleo.whl" }, python: artifact, node: artifact };
  await writeFile(join(resources, "runtime-plan.json"), JSON.stringify(plan));
  return { root, resources, plan };
}

test("offline packages retain their bundled runtimes without installing anything", async t => {
  const { root } = await fixture(t);
  assert.equal(readRuntimePlan(root), null);
  assert.equal(await installRuntime({ resources: root }), root);
  assert.equal(findInstalledRuntime(root, root), root);
});

test("opening an online package requires a complete already-installed matching runtime", async t => {
  const { root, resources } = await fixture(t);
  const { key } = readRuntimePlan(resources);
  assert.throws(() => findInstalledRuntime(resources, root), /运行环境尚未安装/);
  const runtime = join(root, "runtimes/online", key);
  const python = join(runtime, "python", process.platform === "win32" ? "python.exe" : "bin/python3");
  await mkdir(join(runtime, "browser"), { recursive: true });
  await mkdir(join(python, ".."), { recursive: true });
  await writeFile(python, "fixture");
  await writeFile(join(runtime, "browser", process.platform === "win32" ? "node.exe" : "node"), "fixture");
  assert.throws(() => findInstalledRuntime(resources, root), /运行环境尚未安装/);
  await writeFile(join(runtime, "ready.json"), JSON.stringify({ key }));
  assert.equal(findInstalledRuntime(resources, root), runtime);
  assert.equal(await installRuntime({ resources, root: join(root, "runtimes/online") }), runtime);
});

test("tampered lockfiles stop installation before downloading or changing runtimes", async t => {
  const { root, resources } = await fixture(t);
  await writeFile(join(resources, "runtime/requirements.txt"), "tampered");
  t.mock.method(globalThis, "fetch", () => { throw new Error("Must not download"); });
  await assert.rejects(installRuntime({ resources, root: join(root, "cache") }), /Invalid installation file/);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("a corrupt runtime archive is rejected and its staging files are cleaned", async t => {
  const { root, resources } = await fixture(t);
  t.mock.method(globalThis, "fetch", async () => new Response("corrupt"));
  const cache = join(root, "cache");
  await assert.rejects(installRuntime({ resources, root: cache }), /SHA-256/);
  assert.deepEqual(await readdir(cache), ["downloads"]);
  assert.equal((await readFile(join(resources, "runtime/cleo.whl"), "utf8")), "fixture");
});

test("cancelled installation cannot publish a partially prepared runtime", async t => {
  const { root, resources } = await fixture(t);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const cache = join(root, "cache");
  await assert.rejects(installRuntime({ resources, root: cache, signal: controller.signal }), /cancelled/);
  assert.deepEqual(await readdir(cache), []);
});

test("a plan for another architecture cannot be installed", async t => {
  const { resources, plan } = await fixture(t);
  plan.platform = "unsupported-arm64";
  await writeFile(join(resources, "runtime-plan.json"), JSON.stringify(plan));
  assert.throws(() => readRuntimePlan(resources), /does not match/);
});
