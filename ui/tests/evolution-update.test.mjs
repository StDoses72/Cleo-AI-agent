import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { extract, run } from "../electron/evolution-tools.mjs";
import { DesktopUpdater } from "../electron/updater.mjs";

const verboseChild = "process.stderr.write('x'.repeat(17 * 1024 * 1024), () => process.stderr.write('FINAL DIAGNOSTIC', () => { process.exitCode = Number(process.argv[1]); }));";

test("verbose installation commands succeed with a bounded diagnostic tail", async () => {
  const output = await run(process.execPath, ["-e", verboseChild, "0"], { outputMode: "tail" });
  assert.ok(output.length <= 64 * 1024);
  assert.ok(output.endsWith("FINAL DIAGNOSTIC"));
});

test("verbose failed commands retain the exit code and last diagnostic", async () => {
  for (const outputMode of ["capture", "tail"]) {
    await assert.rejects(run(process.execPath, ["-e", verboseChild, "7"], { outputMode }),
      /执行失败 \(7\)\n[\s\S]*FINAL DIAGNOSTIC/);
  }
});

test("metadata capture still refuses truncated results", async () => {
  await assert.rejects(run(process.execPath, ["-e", "process.stdout.write('x'.repeat(17 * 1024 * 1024));"]), /操作输出超过限制/);
});

test("verbose diagnostics cannot overflow or contaminate successful metadata", async () => {
  assert.equal(await run(process.execPath, ["-e", verboseChild, "0"]), "");
});

/** Purpose: Exercise installer state without launching an app. Input: none. Output: ready updater and emitted states. */
function readyUpdater() {
  const states = [];
  const updater = new DesktopUpdater({
    app: { isPackaged: true, getVersion: () => "0.3.9", quit: () => assert.fail("unexpected legacy quit") },
    platform: "win32", arch: "x64", onState: (state) => states.push(state),
    fetchImpl: () => assert.fail("unexpected concurrent update check"),
  });
  updater.manifest = { version: "0.3.11" };
  updater.archivePath = "verified-archive.zip";
  updater.setState({ phase: "ready", latestVersion: "0.3.11" });
  updater.launchInstaller = async () => { throw new Error("unexpected legacy installer"); };
  return { updater, states };
}

test("evolution installation reports preparation and blocks duplicate install/check/download", async () => {
  const { updater, states } = readyUpdater();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const installing = updater.install(async (version) => {
    calls += 1;
    assert.equal(version, "0.3.11");
    await pending;
    return true;
  });
  try {
    assert.equal(updater.getState().phase, "installing");
    assert.equal(await updater.install(() => assert.fail("duplicate install")), false);
    assert.equal((await updater.check()).phase, "installing");
    assert.equal((await updater.download()).phase, "installing");
  } finally {
    release();
    await installing;
  }
  assert.equal(calls, 1);
  assert.deepEqual(states.map(({ phase }) => phase), ["ready", "installing"]);
});

test("preparation failure replaces ready notice and preserves the actionable error", async () => {
  const { updater, states } = readyUpdater();
  await assert.rejects(updater.install(async () => { throw new Error("解压新版失败：磁盘空间不足"); }), /磁盘空间不足/);
  assert.equal(updater.getState().phase, "install-failed");
  assert.match(updater.getState().error, /解压新版失败/);
  assert.deepEqual(states.map(({ phase }) => phase), ["ready", "installing", "install-failed"]);
  assert.equal(await updater.install(() => assert.fail("must recheck before retry")), false);
});

test("a rejected version switch cannot leave the updater installing forever", async () => {
  const { updater } = readyUpdater();
  await assert.rejects(updater.install(async () => false), /未完成版本切换/);
  assert.equal(updater.getState().phase, "install-failed");
});

/** Purpose: Isolate real archive checks. Input: test context. Output: a temporary directory with bounded cleanup. */
async function temporaryDirectory(t) {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, "cleo-update-regression-"));
  t.after(async () => {
    assert.equal(dirname(root), parent);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("failed installation can be retried after rechecking and verifying the archive", async (t) => {
  const root = await temporaryDirectory(t);
  const { updater } = readyUpdater();
  updater.app.getPath = () => root;
  await assert.rejects(updater.install(async () => { throw new Error("temporary preparation failure"); }));
  const archive = Buffer.from("verified retry fixture");
  const manifest = { schema_version: 1, app: "Cleo", version: "0.3.11", platform: "windows-x64",
    archive: "Cleo-windows-x64.zip", bytes: archive.length, sha256: createHash("sha256").update(archive).digest("hex") };
  updater.fetchImpl = async (url) => String(url).endsWith("release.json")
    ? new Response(JSON.stringify(manifest)) : new Response(archive);
  assert.equal((await updater.check()).phase, "available");
  assert.equal((await updater.download()).phase, "ready");
  assert.equal(updater.getState().error, null);
  assert.equal(await updater.install(async () => true), true);
});

test("Windows extraction preserves literal paths and rejects a broken archive", { skip: process.platform !== "win32" }, async (t) => {
  const root = await temporaryDirectory(t);
  const input = join(root, "input.txt");
  const archive = join(root, "新版 [literal].zip");
  const destination = join(root, "已解压 [literal]");
  await writeFile(input, "checked archive content");
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath $env:CLEO_INPUT -DestinationPath $env:CLEO_ZIP"], {
    env: { ...process.env, CLEO_INPUT: input, CLEO_ZIP: archive },
  });
  await extract(archive, destination);
  assert.equal(await readFile(join(destination, "input.txt"), "utf8"), "checked archive content");
  await writeFile(archive, "invalid zip content");
  await assert.rejects(extract(archive, join(root, "broken")), /tar.exe 执行失败/);
});

test("Windows extraction handles release entries longer than MAX_PATH", { skip: process.platform !== "win32" }, async (t) => {
  const root = await temporaryDirectory(t);
  const archive = join(root, "release.zip");
  const destination = join(root, "official-12345678-1234-1234-1234-123456789012");
  const entry = "Cleo/resources/python/Lib/site-packages/anthropic/types/beta/__pycache__/beta_managed_agents_self_hosted_resources_unsupported_deployment_paused_reason_error.cpython-312.pyc";
  assert.ok(join(destination, entry).length > 260);
  // Build ZIP entries directly; fixture generation must not depend on filesystem long-path support.
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [IO.Compression.ZipFile]::Open($env:CLEO_ZIP, 'Create'); try { foreach ($name in @('Cleo/chrome_100_percent.pak', $env:CLEO_LONG_ENTRY)) { $entry = $zip.CreateEntry($name); $writer = [IO.StreamWriter]::new($entry.Open()); try { $writer.Write('release fixture') } finally { $writer.Dispose() } } } finally { $zip.Dispose() }"], {
    env: { ...process.env, CLEO_ZIP: archive, CLEO_LONG_ENTRY: entry },
  });
  await extract(archive, destination);
  assert.equal(await readFile(join(destination, entry), "utf8"), "release fixture");
  assert.equal(await readFile(join(destination, "Cleo/chrome_100_percent.pak"), "utf8"), "release fixture");
  await writeFile(join(destination, entry), "partial previous extraction");
  await extract(archive, destination);
  assert.equal(await readFile(join(destination, entry), "utf8"), "release fixture");
});
