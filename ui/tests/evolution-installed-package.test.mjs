import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createPackage } from "@electron/asar";
import { desktopPlatform } from "../electron/platform.mjs";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);

for (const broken of [false, true]) {
  test(`package smoke ${broken ? "rejects broken" : "accepts working"} packaged detection`, async t => {
    const root = await mkdtemp(join(tmpdir(), "cleo-package-detection-test-"));
    t.after(async () => {
      assert.equal(dirname(root), resolve(tmpdir()));
      await rm(root, { recursive: true, force: true });
    });
    const target = desktopPlatform();
    const bundle = join(root, target.bundle);
    const resources = join(bundle, target.resources);
    const source = join(root, "source");
    await mkdir(resources, { recursive: true });
    await mkdir(dirname(join(bundle, target.executable)), { recursive: true });
    await writeFile(join(bundle, target.executable), "Copy-only fixture; never launched.");
    await cp(join(ui, "electron"), join(source, "electron"), { recursive: true });
    if (broken) {
      const module = join(source, "electron/evolution.mjs");
      const content = await readFile(module, "utf8");
      assert.ok(content.includes("async installedRelease() {"));
      await writeFile(module, content.replace("async installedRelease() {",
        'async installedRelease() { throw new Error("Packaged release detection is broken");'));
    }
    await writeFile(join(source, "package.json"), JSON.stringify({
      name: "cleo-desktop", version: "9.8.7", type: "module", main: "electron/bootstrap.mjs",
    }));
    await createPackage(source, join(resources, "app.asar"));
    await writeFile(join(resources, "evolution-source.tar.gz"), "bundled source snapshot");
    await writeFile(join(target.platform === "darwin" ? resources : bundle, "release.json"),
      JSON.stringify({ app: "Cleo", version: "9.8.7", platform: target.id,
        schema_version: 1, evolution_protocol: 2, build_kind: "official" }));
    const run = () => execute(process.execPath, [join(ui, "tests/evolution-installed-package.smoke.mjs")], {
      env: { ...process.env, CLEO_EXECUTABLE: join(bundle, target.executable) },
      timeout: 30000, windowsHide: true,
    });
    if (broken) await assert.rejects(run(), /Packaged release detection is broken/);
    else assert.equal(JSON.parse((await run()).stdout).status, "passed");
  });
}
