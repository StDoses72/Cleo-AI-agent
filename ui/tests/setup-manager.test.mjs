import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SetupManager } from "../electron/setup-manager.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cleo-setup-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const flags = { installed: false, engine: false, wsl: false, desktop: false };
  const execute = async (command, args) => {
    calls.push([command, args]);
    if (command === "winget.exe") { flags.installed = true; return "installed"; }
    if (command === "powershell.exe") { if (args.at(-1).includes("wsl.exe")) flags.wsl = true; return ""; }
    if (command === "wsl.exe" && !flags.wsl) throw new Error("WSL missing");
    if (command.includes("docker") && (!flags.installed || (args[0] === "info" && !flags.engine))) throw new Error("Docker not ready");
    return "1.0.0";
  };
  const options = { root, toolsRoot: join(root, "tools"), python: "packaged-python", platform: "win32",
    env: { LOCALAPPDATA: root, ProgramFiles: root }, execute,
    prepareTools: async () => ({ node: "node", git: "git", uv: "uv" }),
    repairRuntime: async () => {} };
  return { setup: new SetupManager(options), options, flags, calls };
}

test("first-run scan never installs and consent/selection are enforced at the native seam", async t => {
  const { setup, calls } = await fixture(t);
  const state = await setup.scan();
  assert.equal(state.items.find(item => item.id === "runtime").ready, true);
  assert.deepEqual(state.items.map(item => item.id), ["runtime", "harnesses", "tools"]);
  assert.ok(calls.every(([, args]) => !args.includes("install")));
  await assert.rejects(setup.install(["tools"], false), /确认/);
  await assert.rejects(setup.install(["arbitrary-executable"], true), /列表/);
  assert.ok(calls.every(([command]) => command !== "winget.exe"));
  await setup.dismiss(); assert.equal((await setup.state()).dismissed, true);
});

test("computer use needs no Docker or WSL: nothing is probed, listed or installed", async t => {
  const { setup, calls } = await fixture(t);
  const state = await setup.scan();
  assert.ok(!state.items.some(item => ["docker", "wsl", "desktop"].includes(item.id)));
  assert.ok(calls.every(([command]) => !/docker|wsl|winget/i.test(command)));
  await assert.rejects(setup.install(["docker"], true), /列表/);
  await assert.rejects(setup.install(["desktop"], true), /列表/);
});

test("saved Docker steps from older versions are ignored, not deleted", async t => {
  const { setup, options } = await fixture(t);
  await setup.persist({ items: [{ id: "docker", ready: false }, { id: "runtime", ready: true }],
    pendingIds: ["docker", "desktop", "tools"], message: "准备未完成：old error", restartRequired: true });
  const fresh = new SetupManager(options);
  const before = await fresh.state();
  assert.deepEqual(before.items.map(item => item.id), ["runtime"]);
  assert.deepEqual(before.pendingIds, ["tools"]);
  const { readFile } = await import("node:fs/promises");
  const saved = JSON.parse(await readFile(join(options.root, "setup-v1.json"), "utf8"));
  assert.deepEqual(saved.pendingIds, ["docker", "desktop", "tools"], "older versions keep their saved plan");
  const state = await fresh.scan();
  assert.ok(state.items.every(item => item.ready));
  assert.deepEqual(state.pendingIds, []);
  assert.equal(state.restartRequired, false);
});

test("scan and supported installs preserve retired records, pending plans and unknown fields", async t => {
  const { setup, options, calls } = await fixture(t);
  const retired = { id: "docker", ready: false, custom: { keep: "old Docker metadata" } };
  await setup.persist({ items: [retired, { id: "tools", ready: false, custom: "tool metadata" }],
    pendingIds: ["docker", "desktop", "tools"], futureField: { keep: true } });
  await setup.scan();
  const saved = () => readFile(join(options.root, "setup-v1.json"), "utf8").then(JSON.parse);
  let state = await saved();
  assert.deepEqual(state.items.find(item => item.id === "docker"), retired);
  assert.equal(state.items.find(item => item.id === "tools").custom, "tool metadata");
  await setup.install(["tools"], true);
  state = await saved();
  assert.deepEqual(state.items.find(item => item.id === "docker"), retired);
  assert.deepEqual(state.pendingIds, ["docker", "desktop"]);
  assert.deepEqual(state.futureField, { keep: true });
  assert.ok(calls.every(([command]) => !/docker|wsl|winget/i.test(command)));
  assert.deepEqual((await setup.state()).pendingIds, []);
});

test("failed progress writes release the installation lock and shutdown does not restart probes", async t => {
  const { setup, calls } = await fixture(t);
  await setup.scan();
  const persist = setup.persist.bind(setup);
  setup.persist = async () => { throw new Error("disk unavailable"); };
  await assert.rejects(setup.install(["tools"], true), /disk unavailable/);
  assert.equal(setup.busy, false);
  assert.equal(setup.cancel, null);
  setup.persist = persist;
  await setup.install(["tools"], true);
  await setup.close();
  const before = calls.length;
  await setup.scan();
  await assert.rejects(setup.install(["tools"], true), /退出/);
  assert.equal(calls.length, before);
});

test("startup checks once per version while settings can always rescan", async t => {
  const { options, calls } = await fixture(t);
  const first = new SetupManager({ ...options, version: "1.0" });
  assert.equal((await first.startup()).showOnStartup, true);
  const count = calls.length;
  assert.equal((await new SetupManager({ ...options, version: "1.0" }).startup()).showOnStartup, false);
  assert.equal(calls.length, count);
  const updated = new SetupManager({ ...options, version: "1.1" });
  assert.equal((await updated.startup()).showOnStartup, true);
  const afterUpdate = calls.length;
  await updated.scan();
  assert.ok(calls.length > afterUpdate);
});
