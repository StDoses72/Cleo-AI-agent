import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { desktopPlatform } from "./platform.mjs";
import { installUpdate } from "./posix-installer.mjs";
import { DesktopUpdater } from "./updater.mjs";

for (const [platform, arch] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"]]) {
  test(`${platform}/${arch} updater requests only its matching manifest`, async () => {
    const target = desktopPlatform(platform, arch);
    let requested;
    const updater = new DesktopUpdater({ platform, arch, app: { isPackaged: true, getVersion: () => "0.1.0" },
      fetchImpl: async (url) => {
        requested = url;
        return { ok: true, json: async () => ({ schema_version: 1, app: "Cleo", version: "0.2.0",
          platform: target.id, archive: target.archive, sha256: "a".repeat(64), bytes: 1 }) };
      },
    });
    assert.equal((await updater.check()).phase, "available");
    assert.ok(requested.endsWith(`/${target.manifest}`));
    updater.fetchImpl = async () => ({ ok: true, json: async () => ({ schema_version: 1, app: "Cleo",
      version: "0.2.0", platform: "windows-x64", archive: "Cleo-windows-x64.zip", sha256: "a".repeat(64), bytes: 1 }) });
    assert.equal((await updater.check()).phase, "error");
  });
}

test("native POSIX update validates before quitting and preserves user data", {
  skip: process.platform === "win32", timeout: 60_000,
}, async () => {
  const run = promisify(execFile);
  const target = desktopPlatform();
  const root = await realpath(await mkdtemp(join(tmpdir(), "cleo-posix-update-")));
  const installRoot = join(root, "installed", target.bundle);
  const packageRoot = join(root, "package", target.bundle);
  const metadata = (where) => target.platform === "darwin"
    ? join(where, target.resources, "release.json") : join(where, "release.json");
  try {
    for (const directory of [installRoot, packageRoot]) {
      await mkdir(dirname(metadata(directory)), { recursive: true });
      await mkdir(dirname(join(directory, target.executable)), { recursive: true });
      await writeFile(metadata(directory), JSON.stringify({ app: "Cleo", platform: target.id,
        version: directory === installRoot ? "0.1.0" : "0.2.0" }));
      await copyFile(process.execPath, join(directory, target.executable));
      await chmod(join(directory, target.executable), 0o755);
    }
    if (target.platform === "darwin") {
      await writeFile(join(packageRoot, "Contents", "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Cleo</string><key>CFBundleIdentifier</key><string>ai.cleo.test</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
      await run("codesign", ["--force", "--deep", "--sign", "-", packageRoot]);
    }
    await writeFile(join(installRoot, "obsolete.txt"), "old");
    await writeFile(join(root, "user-data.json"), "keep");
    const archive = join(root, target.archive);
    if (target.platform === "darwin") await run("ditto", ["-c", "-k", "--keepParent", packageRoot, archive]);
    else await run("tar", ["-czf", archive, "-C", dirname(packageRoot), target.bundle]);
    const bytes = await readFile(archive);
    const request = { archive, installRoot, platform: target.id, version: "0.2.0", parentPid: process.pid,
      bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), resultPath: join(root, "result.json") };
    await assert.rejects(installUpdate({ ...request, sha256: "0".repeat(64) }), /checksum/);
    assert.equal(await readFile(join(installRoot, "obsolete.txt"), "utf8"), "old");
    let launched = false;
    await installUpdate(request, { ready: async () => {
      assert.equal(JSON.parse(await readFile(metadata(installRoot), "utf8")).version, "0.1.0");
    }, waitForParent: async () => {}, launch: async (executable) => {
      assert.equal(executable, join(installRoot, target.executable));
      launched = true;
    } });
    assert.equal(launched, true);
    assert.equal(JSON.parse(await readFile(metadata(installRoot), "utf8")).version, "0.2.0");
    assert.equal(JSON.parse(await readFile(request.resultPath, "utf8")).status, "installed");
    assert.equal(await readFile(join(root, "user-data.json"), "utf8"), "keep");
    await assert.rejects(readFile(join(installRoot, "obsolete.txt")), { code: "ENOENT" });

    // Exercise the real parent/installer handoff, including the independent Node copy.
    const resources = join(installRoot, target.resources);
    await mkdir(join(resources, "update"), { recursive: true });
    await mkdir(join(resources, "browser"), { recursive: true });
    for (const file of ["posix-installer.mjs", "platform.mjs"]) {
      await copyFile(new URL(file, import.meta.url), join(resources, "update", file));
    }
    await copyFile(process.execPath, join(resources, "browser", "node"));
    const executable = join(installRoot, target.executable);
    const marker = join(root, "launched.txt");
    const hook = join(root, "launch-hook.cjs");
    await writeFile(hook, `if (process.execPath === ${JSON.stringify(executable)}) require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched');`);
    const harness = join(root, "restart.mjs");
    await writeFile(harness, `
import { DesktopUpdater, validateManifest } from ${JSON.stringify(new URL("updater.mjs", import.meta.url).href)};
const updater = new DesktopUpdater({
  app: { isPackaged: true, getVersion: () => '0.1.0', getPath: () => ${JSON.stringify(root)}, quit: () => process.exit(0) },
  resourcesPath: ${JSON.stringify(resources)}, executablePath: ${JSON.stringify(executable)},
});
updater.manifest = validateManifest(${JSON.stringify({ schema_version: 1, app: "Cleo", version: "0.2.0", platform: target.id, archive: target.archive, bytes: request.bytes, sha256: request.sha256 })});
updater.archivePath = ${JSON.stringify(archive)};
updater.setState({ phase: 'ready' });
await updater.install();
`);
    await run(process.execPath, [harness], { timeout: 20_000,
      env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(hook)}` } });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { await readFile(marker); break; } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await new Promise((done) => setTimeout(done, 100));
      }
    }
    assert.equal(await readFile(marker, "utf8"), "launched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
