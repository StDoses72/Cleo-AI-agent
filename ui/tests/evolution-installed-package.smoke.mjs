import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractAll, extractFile } from "@electron/asar";
import { desktopPlatform, installationRoot } from "../electron/platform.mjs";

// Inspect the actual deliverable, including metadata and source snapshot, instead of a synthetic package.
const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = desktopPlatform();
const executable = resolve(process.env.CLEO_EXECUTABLE || join(ui, "../release", target.bundle, target.executable));
const bundle = installationRoot(executable, target);
const resources = join(bundle, target.resources);
const metadata = JSON.parse((await readFile(join(target.platform === "darwin" ? resources : bundle, "release.json"), "utf8")).replace(/^\uFEFF/, ""));
const packageJson = JSON.parse(extractFile(join(resources, "app.asar"), "package.json"));
assert.equal(metadata.app, "Cleo");
assert.equal(metadata.platform, target.id);
assert.equal(metadata.version, packageJson.version);
assert.notEqual(metadata.build_kind, "local");
assert.ok((await readFile(join(resources, "evolution-source.tar.gz"))).length > 0);
const root = await mkdtemp(join(tmpdir(), "cleo-installed-package-test-"));
let manager;
try {
  const application = join(root, "application");
  extractAll(join(resources, "app.asar"), application);
  const { EvolutionManager } = await import(pathToFileURL(join(application, "electron/evolution.mjs")).href);
  manager = new EvolutionManager({ app: { isPackaged: true, getVersion: () => packageJson.version },
    executable, root: join(root, "evolution"), dataHome: join(root, "home") });
  const oldExecutable = `${target.bundle}/${target.executable}`;
  const alpha = packageJson.version.endsWith("-alpha");
  const oldVersion = alpha ? "0.0.0-alpha" : "0.3.10";
  await mkdir(dirname(join(manager.store.root, "builds/old", oldExecutable)), { recursive: true });
  await writeFile(join(manager.store.root, "builds/old", oldExecutable), "old retained package");
  await manager.store.update({ active: "old", baseline: "old", workspaceBase: "old", builds: [
    { id: "old", kind: "official", version: oldVersion, baseTag: alpha ? "alpha-0.0.0" : "v0.3.10", executable: oldExecutable, baseline: true },
  ] });
  assert.equal((await manager.installedRelease())?.version, packageJson.version,
    "The actual release package must supersede an old official selection, even with its bundled source");
  if (alpha) {
    const state = await manager.store.read();
    await manager.store.update({ builds: state.builds.map(build => ({ ...build, version: "0.3.10", baseTag: "v0.3.10" })) });
    assert.equal(await manager.installedRelease(), null, "An alpha must not replace a stable channel selection");
  }
  console.log(JSON.stringify({ status: "passed", platform: target.id, actualReleaseVersion: packageJson.version,
    officialPackageWithSourceRecognized: true }));
} finally {
  await manager?.close();
  assert.equal(dirname(root), resolve(tmpdir()));
  await rm(root, { recursive: true, force: true });
}
