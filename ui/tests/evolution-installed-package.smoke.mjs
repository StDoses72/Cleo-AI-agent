import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { extractFile } from "@electron/asar";
import { EvolutionManager } from "../electron/evolution.mjs";
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
const manager = new EvolutionManager({ app: { isPackaged: true, getVersion: () => packageJson.version },
  executable, root: join(root, "evolution"), dataHome: join(root, "home") });
try {
  const oldExecutable = `${target.bundle}/${target.executable}`;
  await mkdir(dirname(join(manager.store.root, "builds/old", oldExecutable)), { recursive: true });
  await writeFile(join(manager.store.root, "builds/old", oldExecutable), "old retained package");
  await manager.store.update({ active: "old", baseline: "old", workspaceBase: "old", builds: [
    { id: "old", kind: "official", version: "0.3.10", baseTag: "v0.3.10", executable: oldExecutable, baseline: true },
  ] });
  assert.equal((await manager.installedRelease())?.version, packageJson.version,
    "The actual release package must supersede an old official selection, even with its bundled source");
  console.log(JSON.stringify({ status: "passed", platform: target.id, actualReleaseVersion: packageJson.version,
    officialPackageWithSourceRecognized: true }));
} finally {
  await manager.close();
  assert.equal(dirname(root), resolve(tmpdir()));
  await rm(root, { recursive: true, force: true });
}
