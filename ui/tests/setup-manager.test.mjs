import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
    repairRuntime: async () => {},
    desktop: async action => { if (action === "check") return { ready: flags.engine, version: "29.0.0" }; if (action === "start") flags.desktop = true; return { phase: flags.desktop ? "ready" : "stopped" }; } };
  return { setup: new SetupManager(options), options, flags, calls };
}

test("first-run scan never installs and consent/selection are enforced at the native seam", async t => {
  const { setup, calls } = await fixture(t);
  const state = await setup.scan();
  assert.equal(state.items.find(item => item.id === "runtime").ready, true);
  assert.equal(state.items.find(item => item.id === "docker").ready, false);
  assert.ok(calls.every(([, args]) => !args.includes("install")));
  await assert.rejects(setup.install(["docker"], false), /确认/);
  await assert.rejects(setup.install(["arbitrary-executable"], true), /列表/);
  assert.ok(calls.every(([command]) => command !== "winget.exe"));
  await setup.dismiss(); assert.equal((await setup.state()).dismissed, true);
});

test("successful recheck clears stale Docker failures and pending installation steps", async t => {
  const { setup, flags } = await fixture(t);
  await setup.persist({ pendingIds: ["docker", "desktop"], message: "准备未完成：old error", restartRequired: true });
  flags.installed = flags.engine = flags.wsl = flags.desktop = true;
  const state = await setup.scan();
  assert.ok(state.items.every(item => item.ready));
  assert.deepEqual(state.pendingIds, []);
  assert.equal(state.restartRequired, false);
  assert.equal(state.message, "环境依赖已检查，全部就绪。");
});

test("Docker installer success is not engine readiness and remaining consent survives restart", async t => {
  const { setup, options, flags, calls } = await fixture(t);
  await setup.scan(); await setup.install(["docker", "desktop"], true);
  assert.equal(flags.desktop, false);
  assert.equal((await setup.state()).items.find(item => item.id === "docker").ready, false);
  const next = new SetupManager(options); await next.scan();
  assert.deepEqual((await next.state()).pendingIds, ["docker", "desktop"]);
  flags.engine = true;
  await next.install((await next.state()).pendingIds, true);
  assert.equal(flags.desktop, true);
  assert.equal((await next.state()).items.find(item => item.id === "desktop").ready, true);
  assert.deepEqual((await next.state()).pendingIds, []);
  assert.equal(calls.filter(([command]) => command === "winget.exe").length, 1);
});

test("WSL pauses the approved plan for a system restart without starting Docker prematurely", async t => {
  const { setup, flags, calls } = await fixture(t);
  await setup.scan(); await setup.install(["wsl", "docker", "desktop"], true);
  assert.equal(flags.wsl, true); assert.equal(flags.installed, false);
  assert.equal((await setup.state()).restartRequired, true);
  assert.deepEqual((await setup.state()).pendingIds, ["docker", "desktop"]);
  assert.ok(calls.some(([command, args]) => command === "powershell.exe" && args.at(-1).includes("-Verb RunAs")));
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

test("Docker exit zero with no server version must not mark a missing engine ready", async t => {
  const { options } = await fixture(t);
  const execute = options.execute;
  const setup = new SetupManager({ ...options, execute: (command, args, settings) =>
    command.includes("docker") && args[0] === "info" ? Promise.resolve("") : execute(command, args, settings) });
  const state = await setup.scan();
  assert.equal(state.items.find(item => item.id === "docker").ready, false);
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
