import assert from "node:assert/strict";
import electron from "electron";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { desktopPlatform } from "../electron/platform.mjs";
import { run } from "../electron/evolution-tools.mjs";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "cleo-baseline-smoke-"));
const target = desktopPlatform();
const executable = join(root, target.bundle, target.executable);
try {
  await mkdir(join(root, "desktop"));
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, "Copy-only executable fixture; never launched.");
  const resources = join(root, target.bundle, target.resources);
  await mkdir(resources, { recursive: true });
  const normalArchive = join(ui, "../release", target.bundle, target.resources, "app.asar");
  const archive = process.env.CLEO_EXECUTABLE ? join(dirname(resolve(process.env.CLEO_EXECUTABLE)), target.resources, "app.asar")
    : existsSync(normalArchive) ? normalArchive : join(ui, "../release/Cleo-evolution", target.resources, "app.asar");
  await cp(archive, join(resources, "app.asar"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "cleo-baseline-test", type: "module", main: "main.mjs" }));
  const moduleUrl = pathToFileURL(join(ui, "electron/evolution.mjs")).href;
  await writeFile(join(root, "main.mjs"), [
    'import { app } from "electron";',
    'import { writeFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    'import { createRequire } from "node:module";',
    'const physical = createRequire(import.meta.url)("original-fs").promises;',
    `import { EvolutionManager } from ${JSON.stringify(moduleUrl)};`,
    'void app.whenReady().then(async () => {',
    '  const root = process.env.CLEO_SMOKE_ROOT;',
    '  const manager = new EvolutionManager({',
    '    app: { isPackaged: true, getVersion: () => "0.3.9", getPath: () => join(root, "desktop") },',
    '    root: join(root, "registry"), dataHome: join(root, "home"), executable: process.env.CLEO_SMOKE_EXECUTABLE,',
    '  });',
    '  const first = await manager.ensureBaseline();',
    '  const second = await manager.ensureBaseline();',
    '  if (first.id !== second.id) throw new Error("Repeated preparation replaced the baseline.");',
    '  const obsolete = join(root, "registry/builds/obsolete");',
    '  await physical.cp(first.directory, obsolete, { recursive: true });',
    '  const state = await manager.store.read();',
    '  await manager.store.update({ builds: [...state.builds, { ...state.builds[0], id: "obsolete", baseline: false }] });',
    '  await manager.store.pruneBuilds();',
    '  if ((await physical.readdir(join(root, "registry/builds"))).includes("obsolete")) throw new Error("ASAR bundle cleanup failed.");',
    '  await writeFile(join(root, "result.json"), JSON.stringify(first));',
    '  app.quit();',
    '}).catch((error) => { console.error(error); app.exit(1); });',
  ].join("\n"));
  const env = { ...process.env, CLEO_SMOKE_ROOT: root, CLEO_SMOKE_EXECUTABLE: executable };
  delete env.ELECTRON_RUN_AS_NODE;
  await run(electron, [root, `--user-data-dir=${join(root, "profile")}`], { env, timeout: 30000 });
  const baseline = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
  const source = join(root, target.bundle, target.resources, "app.asar");
  const copied = join(baseline.directory, target.bundle, target.resources, "app.asar");
  assert.deepEqual(await readFile(copied), await readFile(source), "The recovery ASAR must be an exact binary copy.");
  console.log(JSON.stringify({ status: "passed", realElectronBaselineCopy: true, realElectronBundleCleanup: true }));
} finally {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(root.includes("cleo-baseline-smoke-"));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
