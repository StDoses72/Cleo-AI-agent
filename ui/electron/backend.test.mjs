import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import test from "node:test";
import { PassThrough, Writable } from "node:stream";

import { BackendBridge } from "./backend.mjs";

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("legacy desktop profiles migrate into the canonical Cleo home", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-backend-home-"));
  const legacy = join(root, "roaming");
  const canonical = join(root, "local");
  const legacyConfig = join(legacy, "config");
  const canonicalConfig = join(canonical, "config");
  try {
    await mkdir(legacyConfig, { recursive: true });
    await mkdir(canonicalConfig, { recursive: true });
    await writeJson(join(legacyConfig, "cleo.json"), {
      profiles: { agents: { roaming: { model: "roaming-model" }, shared: { model: "old" } } },
    });
    await writeJson(join(canonicalConfig, "cleo.json"), {
      profiles: { agents: { local: { model: "local-model" }, shared: { model: "current" } } },
    });
    await writeJson(join(legacyConfig, "harnesses.json"), {
      providers: { claude: { type: "claude_sdk" } },
    });
    await writeJson(join(canonicalConfig, "harnesses.json"), {
      providers: { codex: { type: "codex_sdk" } },
    });

    const bridge = new BackendBridge({ app: {}, here: "" });
    bridge.migrateLegacyHome({ cleoHome: canonical, legacyCleoHome: legacy });

    const cleo = JSON.parse(await readFile(join(canonicalConfig, "cleo.json"), "utf8"));
    assert.deepEqual(Object.keys(cleo.profiles.agents).sort(), ["local", "roaming", "shared"]);
    assert.equal(cleo.profiles.agents.shared.model, "current");
    const harnesses = JSON.parse(
      await readFile(join(canonicalConfig, "harnesses.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(harnesses.providers).sort(), ["claude", "codex"]);
    assert.ok((await readFile(join(canonical, ".desktop-home-migrated-v1"), "utf8")).trim());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop home receives user-editable AGENTS guidance without overwriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-backend-defaults-"));
  const defaultsRoot = join(root, "defaults");
  const cleoHome = join(root, "home");
  try {
    await mkdir(join(defaultsRoot, "config"), { recursive: true });
    await mkdir(join(defaultsRoot, "memory"), { recursive: true });
    await mkdir(join(defaultsRoot, "assets"), { recursive: true });
    await writeFile(join(defaultsRoot, "config", "cleo.json"), "{}\n", "utf8");
    await writeFile(join(defaultsRoot, "config", "harnesses.json"), "{}\n", "utf8");
    await writeFile(
      join(defaultsRoot, "memory", "MEMORY_POLICY.md"),
      "# Memory Policy\n",
      "utf8",
    );
    await writeFile(join(defaultsRoot, "assets", "startup.png"), "image", "utf8");
    await writeFile(join(defaultsRoot, "AGENTS.md"), "# Default Guidance\n", "utf8");
    await writeFile(join(defaultsRoot, "PERSONA.md"), "# Persona\n", "utf8");

    const bridge = new BackendBridge({ app: {}, here: "" });
    bridge.prepareHome({ cleoHome, defaultsRoot });
    assert.equal(await readFile(join(cleoHome, "AGENTS.md"), "utf8"), "# Default Guidance\n");

    await writeFile(join(cleoHome, "AGENTS.md"), "# My Guidance\n", "utf8");
    bridge.prepareHome({ cleoHome, defaultsRoot });
    assert.equal(await readFile(join(cleoHome, "AGENTS.md"), "utf8"), "# My Guidance\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows desktop backend discovers npm global commands", () => {
  const root = join(tmpdir(), "cleo-backend-path");
  const appData = join(root, "roaming");
  const python = join(root, "python", "python.exe");
  const systemPath = join(root, "system-bin");
  const bridge = new BackendBridge({ app: {}, here: "" });

  const runtimePath = bridge.runtimePath(
    { python, browserRoot: null },
    { APPDATA: appData, PATH: systemPath },
    "win32",
  );

  assert.equal(
    runtimePath,
    [win32.join(dirname(python), "Scripts"), systemPath, win32.join(appData, "npm")].join(";"),
  );
});

function mockBackend(t) {
  const children = [];
  const calls = { paths: 0, prepared: 0 };
  const bridge = new BackendBridge({ app: { isPackaged: false }, here: "", spawnImpl: () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.killCalls = 0;
    child.messages = [];
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      child.messages.push(JSON.parse(chunk.toString()));
      child.onWrite?.();
      done();
    } });
    child.kill = () => { child.killCalls++; child.killed = true; return true; };
    child.reply = (index, result = {}) => child.stdout.write(`${JSON.stringify({
      id: child.messages[index].id, type: "result", result,
    })}\n`);
    child.finish = () => {
      if (child.exitCode !== null) return;
      child.exitCode = 0;
      child.emit("exit", 0);
      child.stdout.end(); child.stderr.end(); child.stdin.end();
    };
    children.push(child);
    return child;
  } });
  bridge.runtimePaths = () => { calls.paths++; return { backendRoot: "/mock", cleoHome: "/mock", python: "mock-python" }; };
  bridge.prepareHome = () => { calls.prepared++; };
  bridge.runtimePath = () => "";
  t.after(() => { for (const child of children) child.finish(); });
  return { bridge, children, calls };
}

test("concurrent closes share one promise and deliver shutdown only to the existing child", async t => {
  const { bridge, children, calls } = mockBackend(t);
  bridge.start();
  const child = children[0];
  let nested;
  child.onWrite = () => { nested = bridge.close(); };
  const closing = bridge.close();
  assert.equal(bridge.close(), closing);
  assert.equal(nested, closing, "Synchronous reentrant close must join the already established close promise");
  assert.deepEqual(child.messages.map(message => message.method), ["shutdown"]);
  await assert.rejects(bridge.request("load_workspace"), /后端正在退出/);
  await assert.rejects(bridge.request("shutdown"), /后端正在退出/, "Public requests must not bypass the close barrier");
  assert.throws(() => bridge.start(), /后端正在退出/);
  assert.equal(children.length, 1);
  assert.equal(calls.prepared, 1);
  let complete = false;
  const observed = closing.then(() => { complete = true; });
  child.reply(0);
  await new Promise(setImmediate);
  assert.equal(child.killCalls, 1);
  assert.equal(complete, false, "Close must wait for process exit after its shutdown response");
  child.finish();
  await observed;
  assert.equal(complete, true);
  assert.equal(bridge.process, null);
});

test("permanent shutdown wins a concurrent restart and cannot revive the backend", async t => {
  const { bridge, children, calls } = mockBackend(t);
  bridge.start();
  const child = children[0];
  const restarting = bridge.restart();
  const shutdown = bridge.shutdown();
  assert.equal(bridge.close(), shutdown);
  assert.equal(bridge.shutdown(), shutdown);
  child.reply(0);
  await new Promise(setImmediate);
  assert.equal(child.killCalls, 1);
  child.finish();
  await Promise.all([restarting, shutdown]);
  assert.equal(bridge.stopped, true);
  assert.equal(bridge.closing, true);
  await bridge.restart();
  await assert.rejects(bridge.request("is_evolution_thread"), /后端正在退出/);
  assert.throws(() => bridge.start(), /后端正在退出/);
  assert.equal(children.length, 1);
  assert.equal(calls.paths, 1);
  assert.equal(calls.prepared, 1);
});

test("shutdown before the first request prevents home preparation and spawning permanently", async t => {
  const { bridge, children, calls } = mockBackend(t);
  await bridge.shutdown();
  await bridge.restart();
  await assert.rejects(bridge.request("load_thread"), /后端正在退出/);
  assert.throws(() => bridge.start(), /后端正在退出/);
  assert.equal(children.length, 0);
  assert.deepEqual(calls, { paths: 0, prepared: 0 });
});

test("ordinary restart waits for close then allows the next request to start a fresh backend", async t => {
  const { bridge, children, calls } = mockBackend(t);
  bridge.start();
  const old = children[0];
  const restarting = bridge.restart();
  await assert.rejects(bridge.request("load_workspace"), /后端正在退出/);
  old.reply(0);
  await new Promise(setImmediate);
  old.finish();
  await restarting;
  assert.equal(bridge.stopped, false);
  assert.equal(bridge.closing, false);
  const result = bridge.request("load_workspace");
  const fresh = children[1];
  assert.equal(fresh.messages[0].method, "load_workspace");
  fresh.reply(0, { ready: true });
  assert.deepEqual(await result, { ready: true });
  assert.equal(children.length, 2);
  assert.equal(calls.prepared, 2);
});

test("a failed close keeps requests blocked but a later close can retry the same child", async t => {
  const { bridge, children } = mockBackend(t);
  bridge.start();
  const child = children[0];
  child.kill = () => { throw new Error("termination failed"); };
  const failed = assert.rejects(bridge.close(), /termination failed/);
  child.reply(0);
  await failed;
  await assert.rejects(bridge.request("load_workspace"), /后端正在退出/);
  assert.equal(children.length, 1);
  child.kill = () => { child.finish(); return true; };
  const retry = bridge.close();
  child.reply(1);
  await retry;
  assert.equal(bridge.process, null);
  assert.deepEqual(child.messages.map(message => message.method), ["shutdown", "shutdown"]);
});
