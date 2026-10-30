import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { findInstalledRuntime, INSTALL_STAGES, installProgress, installRuntime, parseRuntimeRegistry,
  pipProgress, readRuntimePlan, readRuntimeRegistry, RUNTIME_REGISTRY, watchCancellation } from "../electron/online-runtime.mjs";
import { desktopPlatform } from "../electron/platform.mjs";

const hash = data => createHash("sha256").update(data).digest("hex");
const electron = join(dirname(fileURLToPath(import.meta.url)), "../electron");
// prepare-online-package.py ships these modules beside the installer entry point.
const PACKAGED = ["online-runtime.mjs", "release-downloads.mjs", "platform.mjs", "evolution-tools.mjs",
  "evolution-store.mjs", "i18n.mjs", "locales.json", "recovery-locales.json",
  "computer/startup.mjs", "computer/schemes.mjs"];

async function readyRuntime(directory, key) {
  const python = join(directory, "python", process.platform === "win32" ? "python.exe" : "bin/python3");
  await mkdir(join(directory, "browser"), { recursive: true });
  await mkdir(dirname(python), { recursive: true });
  await writeFile(python, "fixture");
  await writeFile(join(directory, "browser", process.platform === "win32" ? "node.exe" : "node"), "fixture");
  await writeFile(join(directory, "ready.json"), JSON.stringify({ key }));
}

function recorder() {
  const events = [];
  const progress = (stage, detail = {}) => events.push({ stage, ...detail });
  return { events, progress };
}

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

test("installer progress replaces its file atomically and prints one line per stage", async t => {
  const root = await mkdtemp(join(tmpdir(), "cleo-progress-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "progress.json");
  const lines = [];
  const report = installProgress(path, { stdout: true, print: text => lines.push(text) });
  report("python-download", { bytes: 0, totalBytes: 2097152 });
  report("python-download", { bytes: 1048576, totalBytes: 2097152 });
  const { updatedAt, ...written } = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(written, { stage: "python-download", label: "Downloading Python", done: null, total: null,
    bytes: 1048576, totalBytes: 2097152 });
  assert.ok(Number.isSafeInteger(updatedAt));
  // A concurrently polling reader, like the Windows installer, only ever observes complete documents.
  const reader = new Worker(`
    const { readFileSync } = require("node:fs");
    const { workerData, parentPort } = require("node:worker_threads");
    let partial = 0, reads = 0;
    parentPort.on("message", () => parentPort.postMessage({ partial, reads }));
    setInterval(() => {
      let text;
      try { text = readFileSync(workerData, "utf8"); } catch { return; }
      try { JSON.parse(text); reads++; } catch { partial++; }
    }, 1);`, { eval: true, workerData: path });
  for (let done = 0; done < 100; done++) report("python-packages", { done, total: 100 });
  const result = await new Promise(resolve => { reader.once("message", resolve); reader.postMessage("result"); });
  await reader.terminate();
  assert.equal(result.partial, 0);
  assert.ok(result.reads > 0);
  report("python-packages", { done: 100, total: 100 });
  assert.equal(JSON.parse(await readFile(path, "utf8")).done, 100);
  report("done");
  assert.deepEqual(lines, ["Cleo installer: Downloading Python (2.0 MB)\n",
    "Cleo installer: Installing Python packages\n", "Cleo installer: Runtime ready\n"]);
  assert.deepEqual(await readdir(root), ["progress.json"]);
});

test("installer progress failures never interrupt installation", async t => {
  const { root, resources } = await fixture(t);
  const report = installProgress(join(root, "missing", "progress.json"), { stdout: true,
    print: () => { throw new Error("closed stdout"); } });
  for (const stage of Object.keys(INSTALL_STAGES)) assert.doesNotThrow(() => report(stage, { done: 1, total: 2 }));
  const { key } = readRuntimePlan(resources);
  await readyRuntime(join(root, "cache", key), key);
  assert.equal(await installRuntime({ resources, root: join(root, "cache"),
    progress: () => { throw new Error("progress unavailable"); } }), join(root, "cache", key));
});

test("a verified prepared runtime is reported and reused", async t => {
  const { root, resources } = await fixture(t);
  const { key } = readRuntimePlan(resources);
  await readyRuntime(join(root, "cache", key), key);
  const { events, progress } = recorder();
  assert.equal(await installRuntime({ resources, root: join(root, "cache"), progress }), join(root, "cache", key));
  assert.deepEqual(events.map(event => event.stage), ["runtime-check", "runtime-ready", "done"]);
  assert.equal(INSTALL_STAGES["runtime-ready"], "Using prepared runtime");
});

test("pip progress counts collected requirements across split output", () => {
  const { events, progress } = recorder();
  const collected = pipProgress([
    "# Generated", "alpha==1.0 \\", "    --hash=sha256:aa", "beta==2.0 ; sys_platform == 'win32' \\",
    "    --hash=sha256:bb", "gamma==3.0 \\", "    --hash=sha256:cc", "delta==4.0", "",
  ].join("\n"), progress);
  for (const chunk of ["Ignoring beta: markers 'sys_platform == \"win32\"' don't match\nColl", "ecting alpha==1.0\n",
    "  Downloading alpha-1.0.whl (1 kB)\r\nCollecting gamma==3.0\nRequirement already satisfied: delta==4.0\n",
    "Installing collected packages: alpha, gamma\nSuccessfully installed alpha gamma\nCollecting ignored\n"])
    collected(chunk);
  assert.deepEqual(events, [
    { stage: "python-packages", done: 0, total: 4 }, { stage: "python-packages", done: 0, total: 3 },
    { stage: "python-packages", done: 1, total: 3 }, { stage: "python-packages", done: 2, total: 3 },
    { stage: "python-packages", done: 3, total: 3 }, { stage: "python-packages" },
  ]);
});

test("a cancel file stops a runtime download and removes its staging", async t => {
  const { root, resources } = await fixture(t);
  t.mock.method(globalThis, "fetch", async (url, { signal }) => new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(new TextEncoder().encode("arc"));
      signal.addEventListener("abort", () => stream.error(signal.reason), { once: true });
    },
  })));
  const cache = join(root, "cache");
  const request = join(root, "cancel");
  const controller = new AbortController();
  t.after(watchCancellation(request, controller, 20));
  const { events, progress } = recorder();
  const installation = installRuntime({ resources, root: cache, signal: controller.signal, progress });
  while (!events.some(event => event.stage === "python-download" && event.bytes === 3))
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(events.find(event => event.stage === "python-download"),
    { stage: "python-download", bytes: 0, totalBytes: 7 });
  await writeFile(request, "cancel");
  await assert.rejects(installation, /cancelled/i);
  assert.equal(controller.signal.reason.message, "Installation cancelled.");
  assert.deepEqual((await readdir(cache)).filter(name => name.startsWith(".install-")), []);
});

test("launching with an installed runtime journals the program location and prunes stale entries", async t => {
  const { root, resources, plan } = await fixture(t);
  const key = readRuntimePlan(resources).key;
  const online = join(root, "runtimes", "online");
  await readyRuntime(join(online, key), key);
  assert.equal(findInstalledRuntime(resources, root), join(online, key));
  const registry = JSON.parse(await readFile(join(online, RUNTIME_REGISTRY), "utf8"));
  assert.deepEqual(Object.keys(registry.installations), [resolve(resources)]);
  assert.equal(registry.installations[resolve(resources)].key, key);
  assert.equal(registry.installations[resolve(resources)].version, plan.version);
  assert.ok(registry.installations[resolve(resources)].updatedAt);
  // Entries for runtimes that no longer exist are dropped; an older entry for this location is refreshed.
  await writeFile(join(online, RUNTIME_REGISTRY), JSON.stringify({ schema: 1, installations: {
    "/elsewhere/resources": { key: hash("gone"), version: "0.1.0" }, [resolve(resources)]: { key, version: "0.0.1" } } }));
  findInstalledRuntime(resources, root);
  const refreshed = readRuntimeRegistry(online);
  assert.deepEqual(Object.keys(refreshed.installations), [resolve(resources)]);
  assert.equal(refreshed.installations[resolve(resources)].version, plan.version);
  // An in-place upgrade switches this location to a new key: the key it leaves stays in history
  // (with the time it left) while its runtime directory exists, so cleanup can retire it later.
  const upgraded = { ...plan, version: "0.6.2" };
  await writeFile(join(resources, "runtime-plan.json"), JSON.stringify(upgraded));
  const newKey = readRuntimePlan(resources).key;
  assert.notEqual(newKey, key);
  await readyRuntime(join(online, newKey), newKey);
  assert.equal(findInstalledRuntime(resources, root), join(online, newKey));
  const afterUpgrade = readRuntimeRegistry(online).installations[resolve(resources)];
  assert.equal(afterUpgrade.key, newKey);
  assert.equal(afterUpgrade.version, "0.6.2");
  assert.deepEqual(afterUpgrade.history.map(item => [item.key, item.version]), [[key, plan.version]]);
  assert.ok(afterUpgrade.history[0].leftAt);
  // Launching again does not duplicate the history item; removing the old runtime prunes it.
  findInstalledRuntime(resources, root);
  assert.equal(readRuntimeRegistry(online).installations[resolve(resources)].history.length, 1);
  await rm(join(online, key), { recursive: true });
  findInstalledRuntime(resources, root);
  assert.deepEqual(readRuntimeRegistry(online).installations[resolve(resources)].history, []);
  // Malformed content is an empty registry, never an exception or a trusted entry.
  assert.deepEqual(parseRuntimeRegistry("nonsense"), { schema: 1, installations: {} });
  assert.deepEqual(parseRuntimeRegistry(JSON.stringify({ schema: 1, installations: {
    "/x": { key: newKey, history: [{ key: "bad" }, { key: newKey }, { key, version: 1 }] } } })).installations["/x"].history,
  [{ key, version: null, leftAt: null }]);
  assert.deepEqual(parseRuntimeRegistry(JSON.stringify({ schema: 1, installations: { a: { key: "short" } } })), { schema: 1, installations: {} });
  // A registry location that cannot be written never blocks startup.
  await rm(join(online, RUNTIME_REGISTRY));
  await mkdir(join(online, RUNTIME_REGISTRY));
  assert.equal(findInstalledRuntime(resources, root), join(online, newKey));
});

test("the packaged entry point reports stages and honours the cancel file", async t => {
  const { root, resources } = await fixture(t);
  for (const name of PACKAGED) {
    await mkdir(dirname(join(resources, name)), { recursive: true });
    await copyFile(join(electron, name), join(resources, name));
  }
  const { key } = readRuntimePlan(resources);
  const data = join(root, "data");
  const runtimes = process.platform === "darwin" ? join(data, "Library/Application Support/Cleo/runtimes/online")
    : join(data, "Cleo/runtimes/online");
  const env = { ...process.env, HOME: data, LOCALAPPDATA: data, XDG_DATA_HOME: data,
    CLEO_INSTALL_PROGRESS: join(root, "progress.json"), CLEO_INSTALL_PROGRESS_STDOUT: "1" };
  const entry = join(resources, "online-runtime.mjs");
  await readyRuntime(join(runtimes, key), key);
  const { stdout } = await promisify(execFile)(process.execPath, [entry], { env });
  assert.deepEqual(stdout.trim().split(/\r?\n/), ["Cleo installer: Checking the Cleo runtime",
    "Cleo installer: Using prepared runtime", "Cleo installer: Runtime ready"]);
  assert.equal(JSON.parse(await readFile(join(root, "progress.json"), "utf8")).stage, "done");
  await rm(runtimes, { recursive: true, force: true });
  await writeFile(join(root, "cancel"), "cancel");
  await assert.rejects(promisify(execFile)(process.execPath, [entry], { env: { ...env, CLEO_INSTALL_CANCEL: join(root, "cancel") } }),
    error => error.code === 1 && /Installation cancelled/.test(error.stderr));
  assert.deepEqual((await readdir(runtimes)).filter(name => name.startsWith(".install-")), []);
});
